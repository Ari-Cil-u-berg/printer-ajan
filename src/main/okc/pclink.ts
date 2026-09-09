import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { log } from '../logger';

/**
 * Hugin PC Link istemcisi — kafedeki yazarkasaya LAN üzerinden konuşur.
 *
 * KAYNAK: https://hugin-pc-link.docs.buildwithfern.com
 *
 * BURADA İSTEMCİ BİZİZ. Cihaz `https://<ip>:4443` üzerinde bir REST sunucusu
 * çalıştırır; belgeyi biz başlatır, biz sonlandırırız. (Hugin'in kablosuz yolu
 * olan Cloud Link'te bu tam tersidir — orada sunucu bizim backend'imizdir ve
 * ajan hiç devrede değildir.)
 *
 * DLL YOK. Doküman açık: "PC tarafında herhangi bir kütüphaneye (DLL) ihtiyaç
 * duymadan https istemci ile Yazarkasa POS iletişimi sağlayabilirsiniz." Eski
 * GMP-3 protokolünün şifreli native kütüphaneleri, sidecar süreçleri ve
 * platform kısıtları bu yolda konu dışı.
 */

/** Cihazın varsayılan portu. */
export const PCLINK_DEFAULT_PORT = 4443;

/** Belge açma/sonlandırma cihazda kart okutmayı bekler; kısa timeout yetmez. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Durum sorgusu kart beklemez. */
const STATUS_TIMEOUT_MS = 8_000;

/**
 * "EFT ödemesi alındı ama belge kapanamadı."
 *
 * Dokümanın en kritik ayrıntısı: bu durumda AYNI `Belge Sonlandır` isteğini
 * birebir tekrar göndermek gerekir. Yeni bir ödeme başlatmak müşteriden ikinci
 * kez para çeker.
 */
export const PCLINK_PARTIAL_STATUS = 206;

export interface PcLinkTarget {
  host: string;
  port: number;
  /**
   * Cihaz sertifikasının SHA-256 parmak izi, ilk başarılı bağlantıda öğrenilir.
   * Sonraki bağlantılarda EŞLEŞMEK ZORUNDA (bkz. `verifyPeer`).
   */
  fingerprint?: string;
  /**
   * `X-HardwareId` — CİHAZIN KABUL ETTİĞİ değer, KEŞİFLE bulunur.
   *
   * Üç kez tahmin ettik, üçü de yanlıştı: makine adından türetilmiş bir etiket,
   * sonra kırpılmamış hâli, sonra VKN. Cihaz üçüne de `"eşleşmiyor"` dedi.
   * Ortak hata tahmin etmekti — bu başlık cihazda KAYITLI bir değerle
   * karşılaştırılıyor.
   *
   * SONUNDA YAZILI BİR KAYNAK: Hugin'in PC Link Postman dokümanında bu başlığın
   * örnek değeri her endpointte `AB:12:3F:14:EE`, ve TSM bölümü "PC Donanım, ve
   * cihaz arasındaki eşleşme de (X-Hardwareid ile) tamamlanmış olur" diyor.
   * Yani CİHAZIN değil, PC'NİN donanım kimliği — adının söylediği şey. Üç
   * tahminimizin de neden tutmadığı burada.
   *
   * Yine de ölçerek ilerliyoruz: `discoverIdentity` adayları — MAC'ler en başta
   * — tek tek cihaza deneyip hangisinin kabul edildiğini bakıyor (`okc.ts`).
   * Buraya yazılan, o ölçümün sonucu. Boşsa VKN'ye düşülüyor.
   */
  hardwareId?: string;
  /**
   * KAFENİN VKN'Sİ — `X-SoftwareId`, ve keşif olmadıysa `X-HardwareId`.
   *
   * Cihaz her iki başlıkta da kendi mükellef kaydındaki vergi numarasını
   * bekliyor; başka bir değer gelirse `"eşleşmiyor"` diyor. İki ayrı başlığın
   * iki ayrı kimlik taşıdığını sandık ve aynı yanılgıya iki kez düştük:
   * `X-SoftwareId` için "10 karakterden uzun olamaz", `X-HardwareId` için
   * "8 karakterden kısa, 20 karakterden uzun olamaz" — ikisi de biçim kuralı
   * değil, beklenen numaranın kendi uzunluğuymuş.
   *
   * Bu yüzden AYRI BİR `hardwareId` ALANI YOK. Kurulum ekranında ayrı bir kutu
   * bırakmak, oraya yazılan her değerin cihazı kilitlemesi demekti — sahada
   * tam olarak bu oldu.
   *
   * Değer NORMALLEŞTİRİLMEZ. Kırpmak ya da uzatmak, eşleşmesi gereken bir
   * numarayı bozmak demek.
   */
  softwareId?: string;
  /**
   * `X-SerialNo` — cihazın kendi sicili.
   *
   * `GET /v1/settings` bunu döndürüyor ve doküman "diğer tüm endpointlarda
   * gönderilmelidir" diyor. Bilinmiyorsa gönderilmiyor: uydurulmuş bir sicil,
   * boş bırakmaktan daha kötü bir cevap alır.
   */
  serialNo?: string;
}

/**
 * Cihazın cevap zarfı.
 *
 * YÜK HER ZAMAN `data` ALTINDA. Doküman metni alanları düz bir tabloda
 * sayıyor — "documentId | string | Cihaz tarafından belgeye atanan tekil ID" —
 * ve biz onları kökte okuyorduk. Şemada ise hepsi `data`'nın içinde ve gerçek
 * cihaz şemaya uyuyor.
 *
 * Tek bir hata, üst üste binen belirtiler üretti: `documentId` hiç okunamadı
 * ("Yazarkasa belge açmadı" — oysa cihaz fişi açmıştı), `state` hiç gelmedi
 * (açık belge uyarısı hiç çalışmadı), `serialNo` hiç öğrenilemedi (ve
 * `X-SerialNo` gönderilemediği için satış "sicil doğrulanamadı" ile
 * reddedildi). Her birini ayrı ayrı kovalamak, tek bir yanlış okumayı üç
 * farklı arıza sanmak olurdu.
 *
 * `body` ZARFIN KENDİSİ kalıyor (`status`, `error`, `metadata`), `data` ise
 * yük. İkisini birleştirmek, bir gün `data.status` gelen bir uçta hangisinin
 * kazandığını belirsizleştirirdi.
 */
export interface PcLinkResponse<T = Record<string, unknown>> {
  httpStatus: number;
  body: {
    status?: string;
    error?: { code?: string; title?: string; description?: string };
    metadata?: { timestamp?: string; sfaVersion?: string };
  };
  /** Cevabın yükü. Zarfta `data` yoksa boş nesne. */
  data: T;
  /** İlk bağlantıda öğrenilen parmak izi — çağıran bunu kaydeder. */
  fingerprint: string;
}

export class PcLinkError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly httpStatus: number | undefined,
  ) {
    super(message);
    this.name = 'PcLinkError';
  }
}

/**
 * Cihaz adresi ÖZEL AĞ ARALIĞINDA olmak zorunda.
 *
 * Adres kullanıcıdan geliyor ve ona satış belgesi POST ediyoruz. Genel bir
 * adrese izin vermek, kafedeki ajanı internete istek yapan bir araca çevirir —
 * yazıcı tarafında aynı gerekçeyle aynı liste var. Yazarkasa tanım gereği
 * kafenin kendi ağındadır; bu kısıt hiçbir gerçek kurulumu engellemez.
 */
export function isPrivateHost(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.trim());
  if (!v4) {
    // İsim verilmişse yalnızca `.local` ve `localhost` — çözümlemeyi cihazın
    // ağına bırakıp adı serbest bırakmak, kısıtı anlamsız kılardı.
    const name = host.trim().toLowerCase();
    return name === 'localhost' || name.endsWith('.local');
  }
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if ([a, b].some((n) => Number.isNaN(n) || n > 255)) return false;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 169.254/16 — DHCP yokken cihazın kendine verdiği adres.
  if (a === 169 && b === 254) return true;
  return false;
}

export class PcLinkClient {
  constructor(private readonly target: PcLinkTarget) {
    if (!isPrivateHost(target.host)) {
      throw new PcLinkError(
        'Yazarkasa adresi yerel ağda olmalı (ör. 192.168.1.50)',
        'ERR_INVALID_PRM',
        undefined,
      );
    }
  }

  /** `GET /v1/status` — cihaz uygun mu, açık belge var mı. */
  status(): Promise<PcLinkResponse> {
    return this.request('GET', '/v1/status', undefined, STATUS_TIMEOUT_MS);
  }

  /** `POST /v1/documents` — belgeyi açar, `documentId` döner. */
  startDocument(docCategory = 'SALE'): Promise<PcLinkResponse<{ documentId?: string }>> {
    return this.request('POST', '/v1/documents', { docCategory });
  }

  /**
   * `PUT /v1/documents/{id}` — belgeyi kalemler ve ödemelerle sonlandırır.
   *
   * COMBO İŞLEM: tek `EFT_POS` ödemesi olan satışlarda `Parçalı Ödeme Ekle`
   * adımı atlanır ve her şey bu tek istekte gider. Doküman bunu öneriyor,
   * ölçülebilir bir hız farkı var ve bir adım eksik olması bir arıza noktası
   * eksik olması demek.
   */
  finalizeDocument(
    documentId: string,
    document: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PcLinkResponse<{ receiptNo?: string; totals?: Record<string, string> }>> {
    return this.request(
      'PUT',
      `/v1/documents/${encodeURIComponent(documentId)}`,
      document,
      DEFAULT_TIMEOUT_MS,
      signal,
    );
  }

  /** `POST /v1/documents/{id}/cancel` — açık belgeyi iptal eder. */
  cancelDocument(documentId: string): Promise<PcLinkResponse> {
    return this.request('POST', `/v1/documents/${encodeURIComponent(documentId)}/cancel`, {});
  }

  /**
   * Cihazın istediği kimlik başlıkları.
   *
   * ÜÇÜ DE OLDUĞU GİBİ GİDER, düzeltilmeden. Hiçbiri bir biçim değil, üçü de
   * bir EŞLEŞME: cihaz kayıtlı değerle karşılaştırıyor ve kırpmak, uzatmak ya
   * da karakter ayıklamak eşleşmesi gereken bir değeri bozmak demek. Boş olanı
   * hiç göndermiyoruz — uydurulmuş bir kimlik, cihazın "boş olamaz" demesinden
   * daha yanıltıcı bir hata veriyor.
   *
   * `X-HardwareId` boşsa VKN'ye düşüyor. Makine adına DEĞİL: makine adı cihazda
   * kayıtlı olmayan bir dizedir ve garanti bir `"eşleşmiyor"` üretir. Kafenin
   * vergi kimliği ise cihazın tanıdığı tek numaradır ve 10 hane (TCKN'de 11)
   * cihazın istediği 8–20 aralığına zaten oturur.
   */
  private identityHeaders(): Record<string, string> {
    const taxId = this.target.softwareId?.trim();
    // Keşifle bulunmuş bir değer varsa O gider; yoksa VKN — cihazın tanıdığı
    // tek numara ve keşif çalışana kadarki en iyi tahmin.
    const hardwareId = this.target.hardwareId?.trim() || taxId;
    return {
      ...(hardwareId ? { 'X-HardwareId': hardwareId } : {}),
      ...(taxId ? { 'X-SoftwareId': taxId } : {}),
      ...(this.target.serialNo?.trim() ? { 'X-SerialNo': this.target.serialNo.trim() } : {}),
    };
  }

  /**
   * Aynı cihaza, BAŞKA BİR `X-HardwareId` ile bakan bir kopya.
   *
   * Keşif bunu kullanıyor: aday değerlerin her biri için ayrı bir istemci
   * kurmak yerine hedefin tek alanını değiştirip aynı bağlantı kurallarını
   * (parmak izi sabitleme, özel ağ kısıtı) koruyor.
   */
  withHardwareId(hardwareId: string | undefined): PcLinkClient {
    return new PcLinkClient({
      ...this.target,
      ...(hardwareId ? { hardwareId } : { hardwareId: undefined }),
    });
  }

  /**
   * `GET /v1/settings` — sicil, mükellef bilgisi, lisans tarihi, departmanlar.
   *
   * `merchant.taxId` BURADAN OKUNUYOR ve önemi büyük: `X-SoftwareId`'nin
   * eşleşmesi gereken numara cihazın kendi mükellef kaydındaki numaradır.
   * Kurulum ekranına elle yazılan değer bir tahmin; bu, cihazın kendi beyanı.
   */
  settings(): Promise<
    PcLinkResponse<{
      serialNo?: string;
      licenceExpirationDate?: string;
      merchant?: { taxId?: string };
    }>
  > {
    return this.request('GET', '/v1/settings', undefined, STATUS_TIMEOUT_MS);
  }

  /**
   * `POST /v1/reports/Z/print` — GÜN SONU. Mali günü KAPATIR.
   *
   * ── Neden `print` ──────────────────────────────────────────────────────────
   * Doküman iki uç veriyor (`/reports/Z` ve `/reports/Z/print`) ve "response
   * formatı, alan yapısı ve alt kırılımlar açısından aynıdır" diyor. Fark
   * makbuzun basılması ve gün sonu bunu gerektiriyor: Z raporu kafenin
   * saklamakla yükümlü olduğu mali bir belge, ekrandaki bir özet değil.
   *
   * ── Neden bu kadar uzun bekliyor ───────────────────────────────────────────
   * Cihaz raporu hesaplıyor, yazdırıyor ve sayaçlarını ilerletiyor. Satış
   * bütçesiyle ölçmek, tam da geri alınamayan işlemin ortasında bağlantıyı
   * koparmak olurdu.
   */
  dailyZ(timeoutMs: number): Promise<PcLinkResponse<Record<string, unknown>>> {
    return this.request('POST', '/v1/reports/Z/print', {}, timeoutMs);
  }

  /**
   * `signal` — bekleyen isteği YARIDA KESMEK için.
   *
   * `Belge Sonlandır` cihazda kart okutulmasını bekliyor ve bütçesi iki
   * dakika. Kasiyer POS'tan iptal ettiğinde o iki dakikayı beklemek, ekranda
   * hiçbir şey olmadan durmak demekti — sahada "2-3 dakika bekledik" diye
   * geri geldi. İptal önce cihazda belgeyi kapatıyor, sonra bu sinyalle
   * bekleyen isteği düşürüyor; sıra tersine olsaydı belgeyi kapatacak
   * bağlantıyı kendi elimizle koparmış olurduk.
   */
  private request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<PcLinkResponse<T>> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new PcLinkError('İstek iptal edildi', 'ERR_ABORTED', undefined));
        return;
      }
      // Parmak izi EL SIKIŞMA ANINDA okunuyor, cevap bittiğinde değil: yanıt
      // gövdesi tükendiğinde soket havuza iade edilmiş ya da kapanmış olabiliyor
      // ve o noktada sertifika artık okunamıyor.
      let peerFingerprint = '';
      let peerError: Error | null = null;
      let aborted = false;

      const req = https.request(
        {
          host: this.target.host,
          port: this.target.port,
          path,
          method,
          timeout: timeoutMs,
          headers: {
            accept: 'application/json',
            ...this.identityHeaders(),
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': payload.length }
              : {}),
          },
          // SERTİFİKA DOĞRULAMASI KAPALI, AMA DOĞRULAMA VAR: cihaz kendi imzaladığı
          // bir sertifika sunuyor ve arkasında güvenilecek bir CA yok, o yüzden
          // zincir doğrulaması hiçbir zaman geçmez. Yerine parmak izi
          // sabitliyoruz (aşağıda): ilk bağlantıda öğrenilen sertifika sonraki
          // her bağlantıda aynı olmak zorunda. Zinciri doğrulamadan parmak izini
          // de kontrol etmemek, aynı ağdaki herhangi bir makinenin yazarkasa
          // taklidi yapabilmesi demekti.
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            if (peerError) {
              reject(peerError);
              return;
            }
            const fingerprint = peerFingerprint;

            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: PcLinkResponse<T>['body'];
            try {
              parsed = (text ? JSON.parse(text) : {}) as PcLinkResponse<T>['body'];
            } catch {
              // Ayrıştırılamayan cevabı "başarılı" saymak, kesilmemiş bir fişi
              // kesilmiş kabul etmektir.
              reject(
                new PcLinkError(
                  'Yazarkasadan okunamayan bir cevap geldi',
                  'ERR_DATA_CORRUPT',
                  res.statusCode,
                ),
              );
              return;
            }

            const envelope = parsed as PcLinkResponse<T>['body'] & { data?: T };
            resolve({
              httpStatus: res.statusCode ?? 0,
              body: envelope,
              data: (envelope.data ?? {}) as T,
              fingerprint,
            });
          });
        },
      );

      req.on('socket', (socket) => {
        const tlsSocket = socket as TLSSocket;
        const capture = (): void => {
          try {
            /*
             * YENİDEN KULLANILAN OTURUMDA SERTİFİKA TEKRAR SUNULMAZ.
             *
             * TLS oturum devamlılığında (`isSessionReused`) sunucu sertifika
             * zincirini yeniden göndermiyor ve `getPeerCertificate()` boş
             * dönüyor. Kimlik kaybolmuyor: devam eden oturum, kriptografik
             * olarak ilk el sıkışmadaki AYNI karşı tarafa bağlı — sabitlemeyi
             * o el sıkışmada zaten yaptık.
             *
             * Bunu ayırt etmemek, ikinci eşzamanlı isteğin "sertifika
             * okunamadı" ile düşmesi demekti. Sahada tek tek istek yaparken
             * hiç görülmedi; kasadan gelen iptal, bekleyen `Belge Sonlandır`
             * ile aynı anda ikinci bir bağlantı açtığı gün ortaya çıktı.
             */
            if (tlsSocket.isSessionReused?.()) {
              peerFingerprint = this.target.fingerprint ?? '';
              return;
            }
            peerFingerprint = this.verifyPeer(tlsSocket);
          } catch (err) {
            peerError = err instanceof Error ? err : new Error(String(err));
            req.destroy();
          }
        };
        /*
         * HAZIR OLMANIN ÖLÇÜSÜ SERTİFİKANIN KENDİSİ, bayraklar değil.
         *
         * Önceki kontrol `!connecting && authorized !== undefined` diyordu ve
         * bu yanıltıcı: TCP bağlantısı kurulmuş ama TLS el sıkışması bitmemiş
         * bir sokette de doğru çıkabiliyor. Tek istek yapılırken hiç
         * görülmedi; iptal, bekleyen `Belge Sonlandır` ile AYNI ANDA ikinci
         * bir istek açtığı gün ortaya çıktı ve iptal "sertifika okunamadı" ile
         * düştü — yani kasiyerin iptali, sebebi görünmeyen bir yarışa takıldı.
         *
         * Sertifikayı okuyabiliyorsak el sıkışma bitmiştir; okuyamıyorsak
         * beklenecek olay zaten `secureConnect`.
         */
        const cert = tlsSocket.getPeerCertificate?.();
        if (cert && 'fingerprint256' in cert && cert.fingerprint256) capture();
        else tlsSocket.once('secureConnect', capture);
      });

      req.on('timeout', () => {
        req.destroy();
        // Zaman aşımı BAŞARISIZLIK DEĞİL, BELİRSİZLİK: cihaz kartı çekmiş ama
        // cevabı bize ulaşmamış olabilir. Çağıran bunu ret olarak yazamaz.
        reject(new PcLinkError('Yazarkasa yanıt vermedi', undefined, undefined));
      });
      req.on('error', (err) => {
        // İPTAL BİR AĞ HATASI DEĞİL. Soketi biz kopardık ve sebebini
        // biliyoruz; `ECONNRESET` diye raporlamak, kasiyerin kendi bastığı
        // düğmeyi bir arıza gibi görmesi olurdu.
        if (aborted) {
          reject(new PcLinkError('İstek iptal edildi', 'ERR_ABORTED', undefined));
          return;
        }
        // Sertifika reddi bir ağ hatası değil: sebebini kaybetmeden yükseltilir.
        reject(peerError ?? new PcLinkError(networkMessage(err), undefined, undefined));
      });

      if (signal) {
        const onAbort = (): void => {
          aborted = true;
          req.destroy();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        req.once('close', () => signal.removeEventListener('abort', onAbort));
      }

      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Sertifika sabitleme (TOFU — ilk görüşte güven).
   *
   * İlk başarılı bağlantıda cihazın sertifika parmak izi kaydedilir; sonrasında
   * değişirse bağlantı reddedilir. Cihazın sertifikası kendinden imzalı olduğu
   * için zincir doğrulaması bir işe yaramıyor, ama "her seferinde AYNI cihaz mı"
   * sorusu yine de cevaplanabilir ve asıl korunmak istenen şey o.
   */
  private verifyPeer(socket: TLSSocket | undefined): string {
    const cert = socket?.getPeerCertificate?.();
    const fingerprint = cert && 'fingerprint256' in cert ? cert.fingerprint256 : '';
    if (!fingerprint) {
      throw new PcLinkError('Yazarkasa sertifikası okunamadı', undefined, undefined);
    }
    if (this.target.fingerprint && this.target.fingerprint !== fingerprint) {
      log.warn('pclink fingerprint mismatch', {
        host: this.target.host,
        expected: this.target.fingerprint.slice(0, 17),
        got: fingerprint.slice(0, 17),
      });
      throw new PcLinkError(
        'Yazarkasa sertifikası değişti — cihaz değiştiyse ayarlardan yeniden tanıtın',
        'ERR_MATCH_ERROR',
        undefined,
      );
    }
    return fingerprint;
  }
}

/** Sistem hatasını kasiyerin okuyabileceği bir cümleye çevirir. */
function networkMessage(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case 'ECONNREFUSED':
      return 'Yazarkasa bağlantıyı reddetti — cihaz açık mı, PC Link etkin mi?';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Yazarkasaya ulaşılamıyor — aynı ağda mı?';
    case 'ETIMEDOUT':
      return 'Yazarkasa yanıt vermedi';
    case 'ENOTFOUND':
      return 'Yazarkasa adresi çözümlenemedi';
    default:
      return err.message || 'Yazarkasa bağlantı hatası';
  }
}
