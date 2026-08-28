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
    if (!this.client || !this.config) {
      this.health = { configured: Boolean(this.config) };
      this.emit('changed');
      return this.health;
    }

    // VKN OLMADAN İSTEK GÖNDERMİYORUZ. Cihaz `X-SoftwareId`'yi zorunlu
    // tutuyor ve PC Link'e girilen VKN ile eşleşmesini bekliyor; boş
    // gönderdiğimizde dönen `"boş olamaz"`, kurulumcuya ne yapacağını
    // söylemiyor. Eksik olduğunu BİZ biliyoruz — cihazın ağzından duymayı
    // beklemek, cevabı olan bir soruyu başkasına sordurmak olurdu.
    if (!this.config.softwareId?.trim()) {
      this.health = {
        configured: true,
        ok: false,
        error: 'Yazılım kimliği girilmedi — PC Link uygulamasına yazdığınız VKN olmalı',
        checkedAt: new Date().toISOString(),
        pendingSale: this.readPending()?.saleId,
      };
      this.emit('changed');
      return this.health;
    }

    try {
      const response = await this.client.status();
      this.rememberFingerprint(response.fingerprint);
      await this.learnSerialNo();

      const body = response.data as { state?: string; activeDocument?: unknown };
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
      this.health = {
        configured: true,
        ok: response.httpStatus === 200,
        ...(failure ? { error: failure } : {}),
        state: body.state,
        // Açık belge kasiyere GÖSTERİLİR: cihazda yarım kalmış bir mali belge
        // varken yeni satış başlatılamaz ve sebebini bilmeden bakmak, cihazı
        // bozuk sanmaya yol açar.
        hasOpenDocument: body.state === 'DOC',
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

    this.emit('changed');
    return this.health;
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
    try {
      const result = await this.finalize(client, documentId, request.document);
      this.clearPending();
      return { saleId: request.saleId, ...result };
    } catch (err) {
      // Cevap kayboldu. Belge cihazda kapanmış OLABİLİR ve kart çekilmiş
      // olabilir. `pending` kaydı diskte kalıyor; kurtarma kasiyerin işi.
      log.warn('okc finalize unknown', { saleId: request.saleId, documentId });
      return {
        saleId: request.saleId,
        status: 'UNKNOWN',
        documentId,
        error: err instanceof Error ? err.message : 'Yazarkasa cevabı alınamadı',
      };
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
  ): Promise<Omit<OkcSaleResult, 'saleId'>> {
    for (let attempt = 0; attempt <= FINALIZE_RETRIES; attempt += 1) {
      const response = await client.finalizeDocument(documentId, document);
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
    const pending = this.readPending();
    if (!pending || !this.client) return { ok: false, error: 'Bekleyen belge yok' };
    try {
      await this.client.cancelDocument(pending.documentId);
      this.clearPending();
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
      if (result.status !== 'UNKNOWN') this.clearPending();
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
  private async learnSerialNo(): Promise<void> {
    if (!this.client || !this.config || this.config.serialNo) return;
    try {
      const response = await this.client.settings();
      const serialNo = response.data.serialNo?.trim();
      if (!serialNo) return;
      this.config = { ...this.config, serialNo };
      this.persist(this.config);
      this.rebuild();
      log.info('okc sicil numarası okundu', { serialNo });
    } catch (err) {
      log.warn('okc sicil numarası okunamadı', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private rememberFingerprint(fingerprint: string): void {
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

function errorText(body: {
  error?: { title?: string; description?: string };
}): string | undefined {
  return body.error?.description?.trim() || body.error?.title?.trim() || undefined;
}
