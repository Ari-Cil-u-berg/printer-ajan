import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { OkcConfig, OkcHealth, OkcSaleRequest, OkcSaleResult } from '../../shared/types';
import { atomicWrite } from '../fsutil';
import { log } from '../logger';
import { PcLinkClient, PcLinkError } from './pclink';

/**
 * Yazarkasa (ÖKC) yöneticisi — kablolu Hugin yolunun ajan tarafı.
 *
 * ÜÇ SONUÇ VAR, İKİ DEĞİL: onaylandı, reddedildi ve **bilmiyorum**. Üçüncüsü bu
 * dosyanın varlık sebebi — cevabı kaybolmuş bir satışı "reddedildi" yazmak,
 * çekilmiş olabilecek parayı adisyona hiç işlememektir. Ağ hatası, zaman aşımı
 * ve süreç çökmesi hep `UNKNOWN`'dır.
 *
 * AÇIK BELGE DİSKE YAZILIR. Doküman `documentId` için "sisteminizde
 * kaybedilmeyecek şekilde kayıt edilerek" diyor ve haklı: ajan `Belge Başlat`
 * ile `Belge Sonlandır` arasında çökerse, cihazda kapatılmayı bekleyen bir mali
 * belge kalır ve onu kapatabilecek tek şey o kimliktir.
 */

/** `206` sonrası aynı isteği kaç kez tekrarlayacağız. */
const FINALIZE_RETRIES = 2;
const HEALTH_INTERVAL_MS = 60_000;

interface PendingSale {
  saleId: string;
  documentId: string;
  document: Record<string, unknown>;
  startedAt: string;
}

export class OkcManager extends EventEmitter {
  private client: PcLinkClient | null = null;
  private health: OkcHealth = { configured: false };
  private healthTimer: NodeJS.Timeout | null = null;
  private readonly pendingPath: string;
  /** Aynı anda tek satış: cihaz da tek belge açabiliyor. */
  private busy = false;
  /**
   * Şu an cihazda bekleyen satış.
   *
   * `busy` bayrağı "meşgul müyüz" sorusunu cevaplıyordu; iptal ise HANGİ
   * satışın beklediğini bilmek zorunda. Kimlik kontrolü olmadan gelen bir
   * iptal, sırada bekleyen başka bir adisyonun belgesini kapatabilirdi.
   */
  private active: { saleId: string; documentId: string; abort: AbortController } | null = null;

  constructor(
    dataDir: string,
    private config: OkcConfig | undefined,
    private readonly persist: (config: OkcConfig) => void,
  ) {
    super();
    this.pendingPath = path.join(dataDir, 'okc-pending.json');
    this.rebuild();
  }

  // --- yapılandırma -------------------------------------------------------

  getConfig(): OkcConfig | undefined {
    return this.config;
  }

  setConfig(config: OkcConfig | undefined): void {
    // Adres değiştiyse parmak izi de sıfırlanır: yeni cihaz, yeni sertifika.
    if (config && this.config && config.host !== this.config.host) {
      delete config.fingerprint;
    }
    this.config = config;
    this.rebuild();
    void this.refreshHealth();
  }

  getHealth(): OkcHealth {
    return this.health;
  }

  private rebuild(): void {
    if (!this.config) {
      this.client = null;
      this.health = { configured: false };
      return;
    }
    try {
      this.client = new PcLinkClient({
        host: this.config.host,
        port: this.config.port,
        ...(this.config.fingerprint ? { fingerprint: this.config.fingerprint } : {}),
        // Boş geçilenler istemcide varsayılana düşüyor; burada `undefined`
        // yollamak `exactOptionalPropertyTypes` altında "alan var ama boş"
        // demek olurdu ve o da cihazın reddettiği durum.
        ...(this.config.hardwareId ? { hardwareId: this.config.hardwareId } : {}),
        ...(this.config.softwareId ? { softwareId: this.config.softwareId } : {}),
        ...(this.config.serialNo ? { serialNo: this.config.serialNo } : {}),
      });
    } catch (err) {
      this.client = null;
      this.health = {
        configured: true,
        ok: false,
        error: err instanceof Error ? err.message : 'Geçersiz adres',
        checkedAt: new Date().toISOString(),
      };
    }
  }

  start(): void {
    this.healthTimer = setInterval(() => void this.refreshHealth(), HEALTH_INTERVAL_MS);
    void this.refreshHealth();
  }

  stop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /** `GET /v1/status` — kasa ekranındaki yeşil/kırmızı göstergenin tek dayanağı. */
  async refreshHealth(): Promise<OkcHealth> {
    const previous = this.health;
    if (!this.client || !this.config) {
      this.health = { configured: Boolean(this.config) };
      this.settleHealth(previous);
      return this.health;
    }

    /**
     * VKN BOŞSA ÖNCE CİHAZA SORUYORUZ.
     *
     * Eskiden burada durup "yazılım kimliği girilmedi" diyorduk ve bu, cevabı
     * olan bir soruyu kurulumcuya sordurmaktı: doğru numara cihazın kendi
     * mükellef kaydında duruyor (`GET /v1/settings` → `merchant.taxId`) ve o
     * çağrı `X-SoftwareId` olmadan da yanıtlanıyor.
     *
     * Cihaz da vermezse eski davranış geri geliyor — ama artık "denedik,
     * cihaz söylemedi" diyerek.
     */
    if (!digitsOf(this.config.softwareId)) {
      await this.learnFromSettings();
    }
    if (!digitsOf(this.config?.softwareId)) {
      this.health = {
        configured: true,
        ok: false,
        error:
          'Yazılım kimliği (VKN) yok — cihazdan da okunamadı. Yazarkasanın mükellef ayarındaki vergi numarasını girin.',
        checkedAt: new Date().toISOString(),
        pendingSale: this.readPending()?.saleId,
      };
      this.settleHealth(previous);
      return this.health;
    }

    try {
      const response = await this.client.status();
      this.rememberFingerprint(response.fingerprint);
      await this.learnFromSettings();

      const body = response.data as {
        state?: string;
        activeDocument?: { documentId?: string };
        lastDocuments?: { documentId?: string; documentStatus?: string }[];
      };
      /*
       * CİHAZIN KENDİ SEBEBİ, kırmızı bir ışık değil.
       *
       * `request()` her HTTP cevabını çözüyor — hata zarfı da dahil — çünkü
       * `206` gibi durumlar bir arıza değil, taşınması gereken bilgi. Bedeli
       * şuydu: 401 dönen bir cevapta sağlık `ok: false` oluyor ve SEBEP hiçbir
       * yere yazılmıyordu. Oysa cihaz tam olarak ne istediğini söylüyor —
       * "X-HardwareId değeri boş olamaz", "X-softwareId eşleşmiyor". Kurulumu
       * yapan kişi kasada duruyor; o cümleyi görmeli.
       */
      // Hata ZARFTA durur, yükte değil — `data` başarılı bir cevabın içeriği.
      const failure = response.httpStatus === 200 ? undefined : errorText(response.body);
      const openDocumentId = body.state === 'DOC' ? openDocument(body) : undefined;
      this.health = {
        configured: true,
        ok: response.httpStatus === 200,
        ...(failure ? { error: failure } : {}),
        state: body.state,
        // Açık belge kasiyere GÖSTERİLİR: cihazda yarım kalmış bir mali belge
        // varken yeni satış başlatılamaz ve sebebini bilmeden bakmak, cihazı
        // bozuk sanmaya yol açar.
        hasOpenDocument: body.state === 'DOC',
        // AJAN KAYDI OLMAYAN AÇIK BELGE de kurtarılabilmeli. Belge açılıp
        // `documentId` bize hiç ulaşamadıysa (ki cevabı yanlış yerden okurken
        // tam bu oluyordu) diskte bir kayıt yok, ama cihaz onu biliyor ve
        // kapanana kadar başka satış kabul etmiyor — "uygun durumda değil".
        // Numarayı cihazdan alıp iptali kasiyere açıyoruz; alternatif, cihazın
        // başına gidip menüden temizlemek.
        ...(openDocumentId ? { openDocumentId } : {}),
        checkedAt: new Date().toISOString(),
        pendingSale: this.readPending()?.saleId,
      };
    } catch (err) {
      this.health = {
        configured: true,
        ok: false,
        error: err instanceof Error ? err.message : 'Bağlantı hatası',
        checkedAt: new Date().toISOString(),
        pendingSale: this.readPending()?.saleId,
      };
    }

    this.settleHealth(previous);
    return this.health;
  }

  /**
   * Sağlık değişimini LOGA DA yazar — yalnızca ekrana değil.
   *
   * Cihazın kendi cümlesi ("x-softwareid eşleşmiyor", "X-HardwareId değeri boş
   * olamaz") tek bir yerde duruyordu: kasadaki Yazarkasa panelinde. Uzaktan
   * bakan kişi için o cümle HİÇ VAR OLMADI — `journalctl` boş, backend zaten
   * bu trafiği görmüyor (PC Link yerel ağda, backend devrede değil). Kurulum
   * hatası "cihaza ulaşılamıyor" diye rapor edildi ve VKN'nin yanlış girildiği
   * ancak kasanın başına gidilince anlaşıldı.
   *
   * YALNIZCA DEĞİŞİMDE yazılıyor. Kontrol altmış saniyede bir dönüyor; aynı
   * cümleyi her turda basmak, günde binden fazla satırla logu okunmaz yapar ve
   * asıl olayı gömerdi. Düzelme de yazılıyor: hatanın ne zaman bittiğini
   * bilmeden, ne zaman başladığını bilmek yarım cevap.
   */
  private settleHealth(previous: OkcHealth): void {
    const error = this.health.error;
    if (error && error !== previous.error) {
      log.warn('okc sağlık hatası', {
        ...(this.config?.host ? { host: this.config.host } : {}),
        error,
        ...(this.health.state ? { state: this.health.state } : {}),
      });
    } else if (!error && previous.error) {
      log.info('okc yeniden bağlandı', {
        ...(this.config?.host ? { host: this.config.host } : {}),
      });
    }
    this.emit('changed');
  }

  // --- satış --------------------------------------------------------------

  /**
   * Mali belgeyi keser.
   *
   * BELGE BURADA KURULMAZ. Backend kurar ve dengesini orada doğrular; ajan
   * yalnızca taşır. Aynı belgeyi Hugin'in kablosuz yolu da gönderiyor ve iki
   * ayrı kurulum, aralarında kuruş farkı olabilen iki mali fiş demekti.
   */
  async sell(request: OkcSaleRequest): Promise<OkcSaleResult> {
    if (!this.client) {
      return { saleId: request.saleId, status: 'DECLINED', error: 'Yazarkasa tanımlanmadı' };
    }
    if (this.busy) {
      // Cihaz tek belge açabiliyor. İkinci satışı sıraya almak yerine
      // reddediyoruz: kasiyer neyin beklediğini görmeden bekleyen bir kuyruk,
      // yanlış fişin yanlış masaya kesilmesinin yoludur.
      return { saleId: request.saleId, status: 'DECLINED', error: 'Yazarkasa meşgul' };
    }

    /**
     * VKN'NİN DOĞRULUK KAYNAĞI CİHAZDIR, SUNUCU DEĞİL.
     *
     * `X-SoftwareId`'nin eşleşmesi gereken numara, cihazın kendi mükellef
     * kaydındaki vergi numarası — `GET /v1/settings` onu döndürüyor ve
     * `learnFromSettings` oradan alıp ayara yazıyor. Sahada "hep x-softwareid
     * yanlış" diyen kurulumların tamamı buydu: doğru numara cihazın içinde
     * duruyordu ve kimse ona sormuyordu.
     *
     * Sunucudan gelen numara YALNIZCA AYAR BOŞKEN yazılıyor. Ayrışıyorlarsa
     * biri yanlış ve bunu uyarı olarak bırakıyoruz; sunucunun kaydıyla cihazın
     * ayarını EZMEK, işletme kaydına yanlış numara girildiği gün çalışan bir
     * kasayı durdurmak olurdu — ve cihaz o numarayı zaten kabul etmez.
     *
     * Satış BU YÜZDEN DURMUYOR: ayrışma bir uyarı, mali bir engel değil.
     */
    const fromServer = digitsOf(request.taxId);
    const configured = digitsOf(this.config?.softwareId);
    if (fromServer && !configured) {
      this.syncSoftwareId(fromServer, 'sunucu');
    } else if (fromServer && configured && fromServer !== configured) {
      log.warn('okc VKN ayrışması — cihazdaki numara kullanılıyor', {
        saleId: request.saleId,
      });
    }

    this.busy = true;
    try {
      return await this.runSale(request);
    } finally {
      this.busy = false;
      this.emit('changed');
    }
  }

  private async runSale(request: OkcSaleRequest): Promise<OkcSaleResult> {
    const client = this.client;
    if (!client) return { saleId: request.saleId, status: 'DECLINED', error: 'Yazarkasa tanımlanmadı' };

    // 1) Belgeyi aç.
    let documentId: string;
    try {
      const started = await client.startDocument('SALE');
      this.rememberFingerprint(started.fingerprint);
      const id = started.data.documentId;
      if (!id) {
        return {
          saleId: request.saleId,
          status: 'DECLINED',
          error: errorText(started.body) ?? 'Yazarkasa belge açmadı',
          code: started.body.error?.code,
        };
      }
      documentId = id;
    } catch (err) {
      // Belge hiç açılmadı: ortada mali belge de, çekilmiş para da yok.
      return {
        saleId: request.saleId,
        status: 'DECLINED',
        error: err instanceof Error ? err.message : 'Belge açılamadı',
        ...(err instanceof PcLinkError && err.code ? { code: err.code } : {}),
      };
    }

    // Kimliği diske YAZ. Buradan sonra çökersek cihazda açık bir belge kalır
    // ve onu kapatabilecek tek şey bu kimlik.
    this.writePending({
      saleId: request.saleId,
      documentId,
      document: request.document,
      startedAt: new Date().toISOString(),
    });

    // 2) Sonlandır — kalemler ve ödemelerle birlikte (combo).
    const abort = new AbortController();
    this.active = { saleId: request.saleId, documentId, abort };
    try {
      const result = await this.finalize(client, documentId, request.document, abort.signal);

      /*
       * REDDEDİLEN BELGE CİHAZDA KAPATILIR — ve bu, ret ile "bilmiyorum"
       * arasındaki farkın tek pratik sonucu.
       *
       * Cihaz sonlandırmayı reddettiğinde (banka terminali bulunamadı, kalem
       * hatalı, KDV tanımsız) ORTADA ÇEKİLMİŞ PARA YOK: ret, ödemenin hiç
       * başlamadığını söylüyor. Ama belge açık kalıyor ve yazarkasa aynı anda
       * tek belge tuttuğu için bir sonraki satışı "uygun durumda değil" ile
       * reddediyor. Kasiyer bunu kendi yaptığı bir şeye bağlayamıyor: ekranda
       * gördüğü hata bir önceki satışa aitti.
       *
       * Kayıt, iptal BAŞARILI olana kadar silinmiyor. Silip de belgeyi açık
       * bırakmak, kurtarma kolunu elimizden atıp cihazı kilitli bırakmaktı —
       * tam olarak sahada yaşanan buydu.
       *
       * `UNKNOWN` ve `206` BURAYA GİRMEZ: orada para çekilmiş olabilir ve
       * belgeyi iptal etmek, alınmış bir ödemenin mali karşılığını silmek
       * olurdu. O ikisinde karar kasiyerin.
       */
      if (result.status === 'DECLINED') {
        const cancelled = await this.cancelQuietly(client, documentId);
        if (cancelled) this.clearPending();
        return { saleId: request.saleId, ...result };
      }

      /*
       * KAYIT YALNIZCA ONAYDA SİLİNİR.
       *
       * `finalize` her zaman FIRLATMIYOR: `206`'da — ödeme alındı, belge
       * kapanmadı — tekrarlar tükendiğinde `UNKNOWN` DÖNDÜRÜYOR. Koşulsuz
       * `clearPending()`, tam da parası çekilmiş bir satışın kurtarma kolunu
       * siliyordu. Kasiyer kağıdı takıp "Tekrar dene"ye bastığında elde
       * denenecek bir şey kalmıyordu; belge cihazda açık, ödeme alınmış,
       * bizde kayıt yok.
       *
       * Fırlatılan hata yolu (aşağıdaki `catch`) kaydı zaten koruyordu — kusur
       * bu iki `UNKNOWN` üretme biçiminin farklı davranmasıydı.
       */
      if (result.status === 'APPROVED') this.clearPending();
      return { saleId: request.saleId, ...result };
    } catch (err) {
      // Cevap kayboldu. Belge cihazda kapanmış OLABİLİR ve kart çekilmiş
      // olabilir. `pending` kaydı diskte kalıyor; kurtarma kasiyerin işi.
      /*
       * BİZİM KOPARDIĞIMIZ BAĞLANTI BELİRSİZLİK DEĞİL.
       *
       * `cancelSale` önce cihazda belgeyi kapatıyor, ancak ondan SONRA bu
       * isteği düşürüyor. Yani buraya `ERR_ABORTED` ile geldiysek belge
       * kapanmış ve ödeme başlamamış demektir — bunu `UNKNOWN` yazmak,
       * kasiyeri olmayan bir tahsilatı araştırmaya göndermek olurdu.
       */
      if (err instanceof PcLinkError && err.code === 'ERR_ABORTED') {
        this.clearPending();
        return {
          saleId: request.saleId,
          status: 'DECLINED',
          documentId,
          error: 'Kasadan iptal edildi',
        };
      }
      log.warn('okc finalize unknown', { saleId: request.saleId, documentId });
      return {
        saleId: request.saleId,
        status: 'UNKNOWN',
        documentId,
        error: err instanceof Error ? err.message : 'Yazarkasa cevabı alınamadı',
      };
    } finally {
      this.active = null;
    }
  }

  /**
   * Kasadan gelen iptal — cihazı BEKLETMEDEN durdurur.
   *
   * SIRA ÖNEMLİ: önce cihazda `Belge İptal`, sonra bekleyen `Belge Sonlandır`
   * isteğini düşürmek. Tersi yapılsaydı belgeyi kapatacak bağlantıyı kendi
   * elimizle koparmış, cihazı açık belgeyle kilitli bırakmış olurduk.
   *
   * KİMLİK KONTROLLÜ: yalnızca adı geçen satış iptal edilir. Kontrolsüz bir
   * iptal, arada başlamış BAŞKA bir adisyonun belgesini kapatabilirdi.
   *
   * CİHAZ HAKEM: PC Link yalnızca hâlâ aktif bir belgeyi iptal ediyor.
   * Ödeme o sırada tamamlandıysa iptal reddediliyor ve bekleyen istek kendi
   * gerçek sonucuyla dönüyor — yani "iptal ettim ama para çekilmişti" durumu
   * bizim değil cihazın kararı.
   */
  async cancelSale(saleId: string): Promise<{ ok: boolean; error?: string }> {
    const client = this.client;
    if (!client) return { ok: false, error: 'Yazarkasa tanımlanmadı' };

    const active = this.active;
    const documentId =
      active?.saleId === saleId
        ? active.documentId
        : this.readPending()?.saleId === saleId
          ? this.readPending()?.documentId
          : undefined;
    if (!documentId) return { ok: false, error: 'Bu satış cihazda beklemiyor' };

    try {
      const response = await client.cancelDocument(documentId);
      if (response.httpStatus !== 200) {
        return { ok: false, error: errorText(response.body) ?? 'Cihaz iptali kabul etmedi' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'İptal edilemedi' };
    }

    log.info('okc satış kasadan iptal edildi', { saleId, documentId });
    if (active?.saleId === saleId) active.abort.abort();
    else this.clearPending();
    void this.refreshHealth();
    return { ok: true };
  }

  /**
   * Belgeyi kapatmayı dener, başarısızlığı yutar.
   *
   * Çağıran zaten bir RET döndürüyor ve iptalin de başarısız olması o rettin
   * sebebini değiştirmiyor. Kasiyere gösterilecek hata, satışın neden
   * reddedildiğidir — "üstelik iptal de edilemedi" cümlesi onu gömerdi.
   * Kapatılamamışsa `pending` kaydı yerinde kalıyor ve Yazarkasa paneli
   * belgeyi göstermeye devam ediyor; kaybolan bir şey yok.
   */
  private async cancelQuietly(client: PcLinkClient, documentId: string): Promise<boolean> {
    try {
      const response = await client.cancelDocument(documentId);
      const ok = response.httpStatus === 200;
      if (!ok) log.warn('okc reddedilen belge iptal edilemedi', { documentId });
      return ok;
    } catch (err) {
      log.warn('okc reddedilen belge iptal edilemedi', {
        documentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * `Belge Sonlandır` + `206` tekrarı.
   *
   * `206` = EFT ödemesi BAŞARILI ama belge kapanmadı (kağıt bitti, pil düştü).
   * Doküman: "Belge Sonlandır mesajı birebir aynı şekilde tekrar gönderilerek
   * sonlandırma tekrar denenir." Yeni bir ödeme başlatmak müşteriden ikinci kez
   * para çekmek olurdu — o yüzden tekrar edilen şey AYNI istektir.
   */
  private async finalize(
    client: PcLinkClient,
    documentId: string,
    document: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Omit<OkcSaleResult, 'saleId'>> {
    for (let attempt = 0; attempt <= FINALIZE_RETRIES; attempt += 1) {
      const response = await client.finalizeDocument(documentId, document, signal);
      this.rememberFingerprint(response.fingerprint);

      const receiptNo = response.data.receiptNo;
      if (response.httpStatus === 200 && receiptNo) {
        return { status: 'APPROVED', receiptNo, documentId, totals: response.data.totals };
      }

      if (response.httpStatus === 206) {
        log.warn('okc 206 — ödeme alındı, belge kapanmadı', { documentId, attempt });
        if (attempt < FINALIZE_RETRIES) continue;
        // Tekrarlar bitti ve ödeme alınmış durumda. Bu bir RET DEĞİL: para
        // çekildi, yalnızca belge kapanmadı. Kasiyer kağıt takıp tekrar
        // denemeli — `pending` kaydı bunun için duruyor.
        return {
          status: 'UNKNOWN',
          documentId,
          error: 'Ödeme alındı ancak fiş kapatılamadı — kağıdı kontrol edip tekrar deneyin',
        };
      }

      return {
        status: 'DECLINED',
        documentId,
        error: errorText(response.body) ?? 'Belge sonlandırılamadı',
        ...(response.body.error?.code ? { code: response.body.error.code } : {}),
      };
    }

    return { status: 'UNKNOWN', documentId, error: 'Belge sonlandırılamadı' };
  }

  /**
   * Yarım kalmış belgeyi iptal eder.
   *
   * Kasiyerin bilinçli kararıdır ve öyle olmalı: ajan kendi başına iptal etseydi,
   * ödemesi alınmış bir belgeyi de iptal etme ihtimali olurdu.
   */
  async cancelPending(): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: 'Yazarkasa tanımlanmadı' };
    // Önce KENDİ kaydımız: gövdesini bildiğimiz belge, tekrar denenebilir olan
    // da odur. Kaydımız yoksa cihazın bildirdiği açık belgeye düşüyoruz —
    // sahipsiz kalmış bir belgeyi kapatmak, cihazı yeniden satışa açmanın tek
    // yolu ve bunu kasiyerin yapabilmesi gerekiyor.
    const documentId = this.readPending()?.documentId ?? this.health.openDocumentId;
    if (!documentId) return { ok: false, error: 'Bekleyen belge yok' };
    try {
      /*
       * CİHAZ KABUL ETMEDİYSE KAYIT SİLİNMEZ.
       *
       * `request()` her HTTP durumunu çözüyor — 4xx dahil — çünkü `206` gibi
       * cevaplar arıza değil, taşınması gereken bilgi. Bedeli burada
       * ödeniyordu: cevabı hiç okumadan `pending` siliniyor ve kasiyere "iptal
       * edildi" deniyordu. Cihaz reddettiğinde belge açık kalıyor, kayıt ise
       * gidiyordu — yani kurtarma kolunu, tam da lazım olduğu anda atmış
       * oluyorduk. Sonraki satış "uygun durumda değil" ile ölüyor ve sebebi
       * kasiyerin gördüğü hiçbir ekranda yazmıyor.
       *
       * `cancelSale` ve `cancelQuietly` bu kontrolü zaten yapıyordu; eksik olan
       * üçüncü yoldu.
       */
      const response = await this.client.cancelDocument(documentId);
      if (response.httpStatus !== 200) {
        const error = errorText(response.body) ?? 'Cihaz iptali kabul etmedi';
        log.warn('okc bekleyen belge iptal edilemedi', { documentId, error });
        void this.refreshHealth();
        return { ok: false, error };
      }
      this.clearPending();
      log.info('okc bekleyen belge iptal edildi', { documentId });
      void this.refreshHealth();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'İptal edilemedi' };
    }
  }

  /** Yarım kalan belgeyi aynı gövdeyle tekrar sonlandırmayı dener. */
  async retryPending(): Promise<OkcSaleResult | null> {
    const pending = this.readPending();
    if (!pending || !this.client || this.busy) return null;

    this.busy = true;
    try {
      const result = await this.finalize(this.client, pending.documentId, pending.document);

      /*
       * RET, `runSale` İLE AYNI ŞEKİLDE KAPATILIR.
       *
       * Burada koşul yalnızca `!== 'UNKNOWN'` idi: reddedilen belge cihazda
       * AÇIK bırakılıyor, kaydı ise siliniyordu. `runSale` aynı durumda
       * `cancelQuietly` çağırıyor ve iptal başarısızsa kaydı koruyor — iki
       * yolun farklı davranması, kurtarma denemesinin cihazı ilk satıştan daha
       * kötü bir hâlde bırakması demekti: sahipsiz açık belge, elde kayıt yok,
       * yeni satış "uygun durumda değil".
       *
       * `UNKNOWN` yine dokunulmadan bırakılıyor — orada ödeme alınmış olabilir
       * ve belgeyi iptal etmek, alınmış bir ödemenin mali karşılığını silmek
       * olurdu.
       */
      if (result.status === 'DECLINED') {
        const cancelled = await this.cancelQuietly(this.client, pending.documentId);
        if (cancelled) this.clearPending();
      } else if (result.status === 'APPROVED') {
        this.clearPending();
      }
      return { saleId: pending.saleId, ...result };
    } catch (err) {
      return {
        saleId: pending.saleId,
        status: 'UNKNOWN',
        documentId: pending.documentId,
        error: err instanceof Error ? err.message : 'Yazarkasa cevabı alınamadı',
      };
    } finally {
      this.busy = false;
      this.emit('changed');
    }
  }

  // --- yardımcılar --------------------------------------------------------

  /**
   * İlk görüşte öğrenilen sertifikayı kaydeder.
   *
   * Bir kez yazılır ve bir daha değişmez: değişmesi gereken tek durum cihazın
   * gerçekten değişmesidir ve o da ayarlardan yeniden tanıtmakla olur.
   */
  /**
   * Sicil numarasını CİHAZDAN öğrenir, kurulumcuya sordurmaz.
   *
   * `GET /v1/settings` onu zaten döndürüyor ve doküman sicili diğer bütün
   * çağrılarda `X-SerialNo` ile göndermeyi istiyor. Elle girdirmenin iki
   * bedeli vardı: numara cihazın kilitli ekranının arkasında olabiliyor, ve
   * yanlış yazılan bir sicil ancak ilk satışta fark ediliyor.
   *
   * Bir kez, sessizce. Başarısız olması sağlığı düşürmez — sicil olmadan da
   * `status` çalışıyor ve bir sonraki kontrolde yeniden denenir.
   */
  private async learnFromSettings(): Promise<void> {
    if (!this.client || !this.config) return;
    // Öğrenecek bir şey kalmadıysa cihazı boşuna yormuyoruz.
    if (this.config.serialNo && digitsOf(this.config.softwareId)) return;
    try {
      const response = await this.client.settings();

      const serialNo = response.data.serialNo?.trim();
      if (serialNo && !this.config.serialNo) {
        this.config = { ...this.config, serialNo };
        this.persist(this.config);
        this.rebuild();
        log.info('okc sicil numarası okundu', { serialNo });
      }

      /**
       * `X-SoftwareId`'NİN DOĞRU KAYNAĞI BURASI.
       *
       * Başlığın eşleşmesi gereken numara, cihazın KENDİ mükellef kaydındaki
       * vergi numarasıdır — kurulum ekranına elle yazılan değil. Sahada "hep
       * x-softwareid yanlış" diyen kurulumların tamamı bu: doğru numara
       * cihazın içinde duruyor ve kimse ona sormuyordu.
       *
       * Cihazın beyanı SUNUCUNUNKİNİ YENER. Ayrışıyorlarsa biri yanlış ve o
       * ayrışma ayrıca uyarı olarak düşüyor; ama cihazınkini kullanmazsak
       * hiçbir çağrı çalışmaz ve kasa tamamen durur.
       */
      const deviceTaxId = digitsOf(response.data.merchant?.taxId);
      if (deviceTaxId) this.syncSoftwareId(deviceTaxId, 'cihaz');
    } catch (err) {
      log.warn('okc ayarları okunamadı', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Sunucunun bildirdiği vergi kimliğini ayara yazar — HER DEĞİŞTİĞİNDE.
   *
   * Eskiden yalnızca kutu boşken yazıyordu ve ayrışma bir hata sayılıyordu.
   * VKN dinamik olunca bu ters döndü: dolu kutunun üstüne yazmamak, işletme
   * kaydı güncellendiği gün kasayı süresiz durdurmak demek.
   *
   * Değişiklikte istemci yeniden kuruluyor: `X-SoftwareId` ve — ayrıca
   * girilmediyse — `X-HardwareId` bu numaradan türüyor, yani eski istemci eski
   * numarayı göndermeye devam ederdi.
   *
   * Eşitse hiçbir şey yapılmıyor. Her satışta diske yazıp istemciyi yeniden
   * kurmak, hiçbir şeyin değişmediği durumda saf gürültü olurdu.
   */
  private syncSoftwareId(taxId: string, source: 'cihaz' | 'sunucu'): void {
    if (!this.config || digitsOf(this.config.softwareId) === taxId) return;
    const previous = digitsOf(this.config.softwareId);
    this.config = { ...this.config, softwareId: taxId };
    this.persist(this.config);
    this.rebuild();
    log.info('okc yazılım kimliği (VKN) güncellendi', {
      source,
      changed: Boolean(previous),
    });
  }

  private rememberFingerprint(fingerprint: string): void {
    // Boş = oturum devam ettiği için sertifika sunulmadı. Öğrenilecek bir şey
    // yok ve boş bir değeri sabitlemek, sonraki her bağlantıyı reddettirirdi.
    if (!fingerprint) return;
    if (!this.config || this.config.fingerprint === fingerprint) return;
    if (this.config.fingerprint) return;
    this.config = { ...this.config, fingerprint };
    this.persist(this.config);
    this.rebuild();
    log.info('okc sertifikası tanındı', { host: this.config.host });
  }

  private readPending(): PendingSale | null {
    try {
      return JSON.parse(fs.readFileSync(this.pendingPath, 'utf8')) as PendingSale;
    } catch {
      return null;
    }
  }

  private writePending(pending: PendingSale): void {
    atomicWrite(this.pendingPath, JSON.stringify(pending));
  }

  private clearPending(): void {
    try {
      fs.rmSync(this.pendingPath, { force: true });
    } catch {
      /* zaten yok */
    }
  }
}

/**
 * Vergi kimliğini karşılaştırılabilir hâle getirir: yalnızca rakamlar.
 *
 * Aynı numara farklı yazılabiliyor — boşluk, nokta, baştaki sıfır. Ham metin
 * karşılaştırmak, doğru numarayı yanlış sanıp çalışan bir kurulumu durdururdu.
 */
function digitsOf(value: string | undefined): string | null {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits.length > 0 ? digits : null;
}

function errorText(body: {
  error?: { title?: string; description?: string };
}): string | undefined {
  return body.error?.description?.trim() || body.error?.title?.trim() || undefined;
}

/**
 * Cihazda açık duran belgenin kimliği.
 *
 * İKİ YERE DE BAKIYOR ve bu bilinçli: dokümanın metni `activeDocument` diyor,
 * şema `lastDocuments` tanımlıyor. Hangisinin geldiğini varsaymak, bu dosyada
 * bir kez pahalıya patlayan tam olarak o hata — metne güvenip şemayı okumamak.
 */
function openDocument(body: {
  activeDocument?: { documentId?: string };
  lastDocuments?: { documentId?: string; documentStatus?: string }[];
}): string | undefined {
  const active = body.activeDocument?.documentId?.trim();
  if (active) return active;

  // Kapanmış bir belgeyi iptal etmeye kalkmak, cihazın reddedeceği bir istek.
  const open = body.lastDocuments?.find(
    (doc) => doc.documentId && doc.documentStatus && !/CLOSED|CANCEL/i.test(doc.documentStatus),
  );
  return open?.documentId?.trim() || undefined;
}
