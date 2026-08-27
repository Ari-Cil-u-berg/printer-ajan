import https from 'node:https';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
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
   * `X-HardwareId` — çağıran makineyi tanıtır.
   *
   * ZORUNLU, dokümanın aksine. OpenAPI tanımı bu üç başlığı da
   * `required: false` işaretliyor; saha cihazı ise başlıksız her isteği
   * `ERR_UNAUTHORIZED — "X-HardwareId değeri boş olamaz"` ile reddediyor.
   * Dokümana güvenip göndermemek, `GET /v1/status` dahil HİÇBİR çağrının
   * çalışmaması demekti — sağlık göstergesi kırmızı, sebebi görünmez.
   */
  hardwareId?: string;
  /** `X-SoftwareId` — çağıran uygulamayı tanıtır. Aynı sebeple gönderiliyor. */
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

/** Cihaz boş bırakılmasına izin vermiyor; kimliği yoksa da bir şey göndermeli. */
const DEFAULT_SOFTWARE_ID = 'ari-adisyon-ajan';

/**
 * Cihazın kimlik başlıklarına dayattığı uzunluk aralığı.
 *
 * SAHADAN ÖĞRENİLDİ, dokümandan değil: OpenAPI tanımı bu başlıkları hiç
 * kısıtlamıyor, `X-HardwareId: kasa-1` gönderen istek ise
 * `"x-hardwareid değeri 8 karakterden kısa, 20 karakterden uzun olamaz"`
 * ile reddediliyor. Kısıt YALNIZCA `X-HardwareId` için doğrulandı;
 * `X-SoftwareId` de aynı ölçüye sokuluyor çünkü kuralın ona da uyduğunu
 * varsaymak, uymadığını sahada öğrenmekten ucuz — varsayılanımız zaten
 * aralıkta.
 */
const ID_MIN_LENGTH = 8;
const ID_MAX_LENGTH = 20;

/**
 * Serbest metni cihazın kabul ettiği bir kimliğe çevirir.
 *
 * KISA OLANI UZATMAK, uzun olanı kesmek. "kasa-1" yazan kurulumcu haklı — o ad
 * kafede anlamlı; başlığın uzunluk kuralı bizim iç meselemiz ve kullanıcıya
 * hata olarak dönmesi gereksiz. Uzatma, adın kendisinden türetilen kararlı bir
 * ekle yapılıyor: aynı makine her açılışta aynı kimliği göndermeli, yoksa
 * cihaz tarafındaki kayıtlarda tek kasa birden çok görünür.
 */
function normalizeId(raw: string, seed: string): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]/g, '');
  if (cleaned.length >= ID_MIN_LENGTH) return cleaned.slice(0, ID_MAX_LENGTH);

  const suffix = createHash('sha256').update(seed || cleaned).digest('hex');
  return `${cleaned}${suffix}`.slice(0, ID_MIN_LENGTH + 8);
}

export interface PcLinkResponse<T = Record<string, unknown>> {
  httpStatus: number;
  body: T & {
    status?: string;
    error?: { code?: string; title?: string; description?: string };
    metadata?: { timestamp?: string; sfaVersion?: string };
  };
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
  ): Promise<PcLinkResponse<{ receiptNo?: string; totals?: Record<string, string> }>> {
    return this.request('PUT', `/v1/documents/${encodeURIComponent(documentId)}`, document);
  }

  /** `POST /v1/documents/{id}/cancel` — açık belgeyi iptal eder. */
  cancelDocument(documentId: string): Promise<PcLinkResponse> {
    return this.request('POST', `/v1/documents/${encodeURIComponent(documentId)}/cancel`, {});
  }

  /**
   * Cihazın istediği kimlik başlıkları.
   *
   * `X-HardwareId` boş GEÇİLEMEZ — cihaz isteği reddediyor. Yapılandırmada
   * yoksa makinenin kendi adına düşüyoruz: bu başlığın işi çağıranı ayırt
   * etmek ve kafedeki tek kasanın adı bunu yapar. Sabit bir dize yazmak,
   * ikinci bir kasa eklendiği gün ikisini ayırt edilemez kılardı.
   */
  private identityHeaders(): Record<string, string> {
    const machine = hostname();
    return {
      'X-HardwareId': normalizeId(this.target.hardwareId?.trim() || machine, machine),
      'X-SoftwareId': normalizeId(
        this.target.softwareId?.trim() || DEFAULT_SOFTWARE_ID,
        DEFAULT_SOFTWARE_ID,
      ),
      ...(this.target.serialNo?.trim() ? { 'X-SerialNo': this.target.serialNo.trim() } : {}),
    };
  }

  /** `GET /v1/settings` — sicil, mükellef bilgisi, lisans tarihi, departmanlar. */
  settings(): Promise<
    PcLinkResponse<{ serialNo?: string; licenceExpirationDate?: string }>
  > {
    return this.request('GET', '/v1/settings', undefined, STATUS_TIMEOUT_MS);
  }

  private request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<PcLinkResponse<T>> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');

    return new Promise((resolve, reject) => {
      // Parmak izi EL SIKIŞMA ANINDA okunuyor, cevap bittiğinde değil: yanıt
      // gövdesi tükendiğinde soket havuza iade edilmiş ya da kapanmış olabiliyor
      // ve o noktada sertifika artık okunamıyor.
      let peerFingerprint = '';
      let peerError: Error | null = null;

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

            resolve({
              httpStatus: res.statusCode ?? 0,
              body: parsed as PcLinkResponse<T>['body'],
              fingerprint,
            });
          });
        },
      );

      req.on('socket', (socket) => {
        const tlsSocket = socket as TLSSocket;
        const capture = (): void => {
          try {
            peerFingerprint = this.verifyPeer(tlsSocket);
          } catch (err) {
            peerError = err instanceof Error ? err : new Error(String(err));
            req.destroy();
          }
        };
        // Soket havuzdan geldiyse el sıkışma çoktan bitmiştir.
        if (tlsSocket.authorized !== undefined && typeof tlsSocket.getPeerCertificate === 'function' && !tlsSocket.connecting) {
          capture();
        } else {
          tlsSocket.once('secureConnect', capture);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        // Zaman aşımı BAŞARISIZLIK DEĞİL, BELİRSİZLİK: cihaz kartı çekmiş ama
        // cevabı bize ulaşmamış olabilir. Çağıran bunu ret olarak yazamaz.
        reject(new PcLinkError('Yazarkasa yanıt vermedi', undefined, undefined));
      });
      req.on('error', (err) => {
        // Sertifika reddi bir ağ hatası değil: sebebini kaybetmeden yükseltilir.
        reject(peerError ?? new PcLinkError(networkMessage(err), undefined, undefined));
      });

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
