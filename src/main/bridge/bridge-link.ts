import { EventEmitter } from 'node:events';
import { io, type Socket } from 'socket.io-client';
import type { BridgePairing, OkcSaleResult } from '../../shared/types';
import { log } from '../logger';

/**
 * Ödeme köprüsü — backend'in satış emrini taşıyan kanal.
 *
 * NEDEN YAZICI SOKETİ DEĞİL: ajan zaten `/agent` üzerinde ham bir WebSocket
 * tutuyor ve fiş oraya akıyor. Satış emri oradan da geçebilirdi ama bedeli
 * backend'de ikinci bir dağıtım mantığı yazmaktı: çok sunuculu kurulumda
 * "bu cihazın soketi hangi düğümde" sorusu, sonuç korelasyonu ve kayıp cevap
 * kurtarması. `/bridge` bunların hepsini zaten çözmüş durumda — Redis
 * adapter'ı, oda bazlı yayın, `ack`/`result` eşleşmesi ve timeout süpürgesi.
 * Ajana bir bağımlılık eklemek, aynı mantığın ikinci bir kopyasını yazmaktan
 * ucuz.
 *
 * İKİ AYRI KİMLİK, bilerek: yazıcı ajanı bir `Printer` satırıdır, köprü ise bir
 * `Terminal`. Aynı bilgisayarda çalışsalar bile ayrı eşleştirilirler; birini
 * iptal etmek diğerini düşürmemeli.
 */

const API_PREFIX = '/api/v1';
/** Token'ın ömrü dolmadan yenile — bağlantı kopmadan. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const HEARTBEAT_MS = 30_000;

/** Backend → ajan. `bridge.protocol.ts` ile aynı; TEK KAYNAK orası. */
const ServerEvents = {
  SALE: 'terminal.sale',
  CANCEL: 'terminal.cancel',
  QUERY_LAST: 'terminal.query-last',
} as const;

/** Ajan → backend. */
const ClientEvents = {
  ACK: 'terminal.ack',
  RESULT: 'terminal.result',
  QUERY_RESULT: 'terminal.query-result',
  HEARTBEAT: 'terminal.heartbeat',
} as const;

interface SalePayload {
  intentId: string;
  terminalId: string;
  amountMinor: number;
  currency: string;
  timeoutMs: number;
  reference: string;
  /** Kafenin vergi kimliği — cihaza `X-SoftwareId` olarak gider. */
  taxId?: string;
  fiscal?: { format: string; document: Record<string, unknown> };
}

interface QueryPayload {
  terminalId: string;
  intentId: string;
  requestId: string;
}

export interface BridgeLinkOptions {
  apiBaseUrl: string;
  pairing: BridgePairing;
  deviceKey: string;
  agentVersion: string;
  /** Satışı cihaza veren taraf — `OkcManager.sell`. */
  sell: (input: {
    saleId: string;
    document: Record<string, unknown>;
    taxId?: string;
  }) => Promise<OkcSaleResult>;
  /** "Bu satış ne oldu?" — yalnızca BİZİM işlemimiz için cevap verir. */
  lookup: (saleId: string) => OkcSaleResult | null;
  /** Cihaz şu an ulaşılabilir mi — heartbeat'e yazılır. */
  reachable: () => boolean;
  /** Kasadan gelen iptali cihaza taşır. Yalnızca adı geçen satış için. */
  cancelSale: (saleId: string) => Promise<{ ok: boolean; error?: string }>;
}

export class BridgeLink extends EventEmitter {
  private socket: Socket | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private connected = false;

  constructor(private readonly opts: BridgeLinkOptions) {
    super();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.open();
  }

  stop(): void {
    this.closed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.refreshTimer = null;
    this.heartbeatTimer = null;
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  private async open(): Promise<void> {
    if (this.closed) return;

    let token: { token: string; expiresIn: number };
    try {
      token = await this.issueToken();
    } catch (err) {
      // Token alınamadı: ağ ya da iptal edilmiş anahtar. Yeniden denemeyi
      // socket'in kendi backoff'una bırakamıyoruz — henüz socket yok.
      log.warn('bridge token alınamadı', { error: message(err) });
      this.scheduleRetry();
      return;
    }

    const socket = io(`${origin(this.opts.apiBaseUrl)}/bridge`, {
      auth: { token: token.token },
      transports: ['websocket'],
      // Ajan dışa doğru bağlanır; NAT arkasındaki kasada dinleyen bir port yok.
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.connected = true;
      log.info('bridge bağlandı', { terminal: this.opts.pairing.terminalLabel });
      this.sendHeartbeat();
      this.emit('changed');
    });

    socket.on('disconnect', (reason) => {
      this.connected = false;
      log.warn('bridge bağlantısı düştü', { reason });
      this.emit('changed');
    });

    socket.on('connect_error', (err) => {
      log.warn('bridge bağlantı hatası', { error: err.message });
    });

    // Backend token'ı reddettiyse yeniden denemek işe yaramaz: anahtar
    // iptal edilmiş ya da terminal devre dışı bırakılmıştır.
    socket.on('unauthorized', () => {
      log.warn('bridge yetkisi reddedildi — eşleştirme kaldırıldı');
      this.closed = true;
      socket.close();
      this.connected = false;
      this.emit('unauthorized');
    });

    socket.on(ServerEvents.SALE, (payload: SalePayload) => void this.onSale(payload));
    socket.on(ServerEvents.QUERY_LAST, (payload: QueryPayload) => this.onQuery(payload));
    socket.on(ServerEvents.CANCEL, (payload: { intentId: string }) => {
      void this.onCancel(payload.intentId);
    });
  }

  /**
   * Kasadan gelen iptal — cihazı BEKLETMEDEN durdurur.
   *
   * Eskiden burası yalnızca logluyordu ve gerekçesi şuydu: cihazda açık bir
   * belgenin ödemesi alınmış olabilir, kararı kasiyer versin. Bedeli sahada
   * görüldü — kasiyer POS'tan iptal ediyor, ekran "İPTAL EDİLDİ" diyor, cihaz
   * ise kart bekleyerek iki dakika daha duruyor. İki ekran iki farklı gerçek
   * gösteriyor ve doğru olan cihazınki.
   *
   * KARARI YİNE CİHAZ VERİYOR: PC Link yalnızca hâlâ AKTİF bir belgeyi iptal
   * ediyor. Ödeme o arada tamamlandıysa iptal reddediliyor ve bekleyen satış
   * kendi gerçek sonucuyla dönüyor. Yani "alınmış ödemeyi silme" güvencesi
   * kayboluyor değil, hakemliği bize değil cihaza bırakılıyor.
   *
   * SONUÇ GERİ BİLDİRİLMİYOR: backend iptali kendi tarafında zaten
   * `CANCELLED`'a aldı ve `terminal.result` yalnızca APPROVED/DECLINED
   * taşıyor. Buradan bir ret göndermek, kapanmış bir kaydı ikinci kez
   * kapatmaya çalışmak olurdu.
   */
  private async onCancel(intentId: string): Promise<void> {
    const result = await this.opts.cancelSale(intentId);
    if (result.ok) {
      log.info('bridge iptali cihaza uygulandı', { intentId });
      return;
    }
    // Uygulanamaması beklenen bir durum: emir cihaza hiç ulaşmamış olabilir,
    // ya da ödeme tamamlanmış olabilir. İkisi de kasiyerin göreceği ekranda
    // zaten anlaşılıyor; burada sessiz kalmak, sebebini kaybetmek olurdu.
    log.warn('bridge iptali cihaza uygulanamadı', { intentId, error: result.error });
  }

  /**
   * Satış emri.
   *
   * ÖNCE ACK, SONRA SATIŞ. `ack` "emri aldım" der, "para çekildi" demez —
   * backend bu ikisini ayırt ediyor ve ack'siz bir emir, hiç ulaşmamış sayılıp
   * kurtarmaya düşüyor.
   */
  private async onSale(payload: SalePayload): Promise<void> {
    const document = payload.fiscal?.document;

    if (!document || payload.fiscal?.format !== 'HUGIN_PCLINK_V1') {
      // Tanımadığımız bir belge biçimini YORUMLAMIYORUZ. Eski bir ajanın yeni
      // bir şemayı "yaklaşık" çalıştırması, yanlış fiş kesmenin en sessiz yolu.
      this.emitAck(payload.intentId, false, 'Bu ajan bu belge biçimini tanımıyor');
      return;
    }

    this.emitAck(payload.intentId, true);

    const result = await this.opts.sell({
      saleId: payload.intentId,
      document,
      ...(payload.taxId ? { taxId: payload.taxId } : {}),
    });
    this.emitResult(result);
  }

  /**
   * "Bu işlem ne oldu?" — BİZİM işlemimiz sorulur, cihazın son işlemi değil.
   *
   * Eşleşmiyorsa doğru cevap `null` ("bilmiyorum"). Başka bir adisyonun onayını
   * buraya yazmak, ödenmemiş bir hesabı kapatmaktır.
   */
  private onQuery(payload: QueryPayload): void {
    const known = this.opts.lookup(payload.intentId);
    const socket = this.socket;
    if (!socket) return;

    socket.emit(ClientEvents.QUERY_RESULT, {
      requestId: payload.requestId,
      result:
        known && known.status !== 'UNKNOWN'
          ? {
              status: known.status,
              ...(known.receiptNo ? { providerRef: known.receiptNo } : {}),
              ...(known.error ? { failureReason: known.error } : {}),
            }
          : null,
      ...(known ? { intentId: payload.intentId } : {}),
    });
  }

  /**
   * Satış emrinin DIŞINDA çıkan bir sonucu bildirir — kasiyerin "Tekrar dene"si.
   *
   * `emitResult` yalnızca `onSale` içinden çağrılıyordu: kurtarma başarılı olsa
   * bile backend'e hiçbir şey gitmiyor, sonuç yalnızca `lookup` cevabı olarak
   * SORULURSA duyuluyordu. Süpürge o soruyu bir kez soruyor — tahsilat
   * TIMEOUT'a düştüğü an — ve o an kasiyer henüz kağıdı takmamışsa cevap
   * dürüstçe `null` oluyor. Sonrasında fiş kesilse bile kimse tekrar sormuyor:
   * mali fiş var, adisyon açık.
   *
   * Backend `TIMEOUT → APPROVED` geçişine izin veriyor (durum makinesindeki tek
   * geri dönüş) ve aynı sonucun ikinci kez gelmesini sessizce yutuyor, yani bu
   * bildirimi geç göndermek güvenli — göndermemek değildi.
   */
  reportResult(result: OkcSaleResult): void {
    this.emitResult(result);
  }

  private emitAck(intentId: string, accepted: boolean, reason?: string): void {
    this.socket?.emit(ClientEvents.ACK, {
      intentId,
      accepted,
      ...(reason ? { reason } : {}),
    });
  }

  private emitResult(result: OkcSaleResult): void {
    // `UNKNOWN` GÖNDERİLMEZ ve bu bilerek: köprü protokolü yalnızca APPROVED /
    // DECLINED tanıyor, çünkü "bilmiyorum" backend'de zaten bir durum —
    // cevapsızlık. Sustuğumuzda intent SENT'te kalıyor, süpürge onu TIMEOUT'a
    // alıp `query-last` ile bize soruyor ve o soruya da dürüstçe `null`
    // dönüyoruz. Yanlış olan, belirsizliği DECLINED diye bildirmek olurdu.
    if (result.status === 'UNKNOWN') {
      log.warn('bridge: sonuç belirsiz, bildirilmedi', { saleId: result.saleId });
      return;
    }

    this.socket?.emit(ClientEvents.RESULT, {
      intentId: result.saleId,
      status: result.status,
      ...(result.receiptNo ? { providerRef: result.receiptNo } : {}),
      ...(result.error ? { failureReason: result.error } : {}),
      ...(result.code ? { slip: { code: result.code } } : {}),
      ...(result.receiptNo ? { fiscal: { receiptNo: result.receiptNo } } : {}),
    });
  }

  private sendHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const beat = (): void => {
      this.socket?.emit(ClientEvents.HEARTBEAT, {
        terminalId: this.opts.pairing.terminalId,
        // Ajan ayakta ama yazarkasa kapalı olabilir; ikisi ayrı sorular.
        deviceReachable: this.opts.reachable(),
        agentVersion: this.opts.agentVersion,
      });
    };
    beat();
    this.heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  }

  /** Kalıcı anahtarı kısa ömürlü socket token'ına çevirir ve yenilemeyi kurar. */
  private async issueToken(): Promise<{ token: string; expiresIn: number }> {
    const res = await fetch(`${this.opts.apiBaseUrl}${API_PREFIX}/bridge/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: this.opts.pairing.deviceId,
        deviceKey: this.opts.deviceKey,
      }),
    });

    if (res.status === 401 || res.status === 403) {
      this.closed = true;
      this.emit('unauthorized');
      throw new Error('Köprü anahtarı geçersiz');
    }
    if (!res.ok) throw new Error(`Köprü token'ı alınamadı — ${await reason(res)}`);

    const body = (await res.json()) as { data?: { token?: string; expiresIn?: number } };
    const token = body.data?.token;
    if (!token) throw new Error("Köprü token'ı boş döndü");

    const expiresIn = body.data?.expiresIn ?? 900;
    // Süresi dolmadan yenile: dolmuş bir token'la yeniden bağlanma denemesi,
    // her seferinde bir reddedilmiş handshake demek.
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(
      () => void this.reconnectWithFreshToken(),
      Math.max(30_000, expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS),
    );

    return { token, expiresIn };
  }

  private async reconnectWithFreshToken(): Promise<void> {
    if (this.closed) return;
    log.debug('bridge token yenileniyor');
    this.socket?.close();
    this.socket = null;
    await this.open();
  }

  private scheduleRetry(): void {
    if (this.closed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.open();
    }, 15_000);
  }
}

/**
 * Kurulum kodunu kalıcı köprü kimliğiyle takas eder.
 *
 * Anahtar YALNIZCA burada, yalnızca bir kez düz metin görünür — çağıran onu
 * doğrudan güvenli depoya yazmalı, ekrana değil.
 */
export async function pairBridge(apiBaseUrl: string, code: string): Promise<BridgePairing & { deviceKey: string }> {
  const res = await fetch(`${apiBaseUrl}${API_PREFIX}/bridge/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.trim().toUpperCase() }),
  });

  if (!res.ok) {
    // Sunucu "yanlış/süresi dolmuş/kullanılmış" için tek tip mesaj veriyor;
    // burada da ayırmıyoruz, çünkü ayırmak bir yabancıya devam etmesi
    // gerektiğini söylemek olur.
    throw new Error('Kurulum kodu geçersiz ya da süresi dolmuş');
  }

  const body = (await res.json()) as {
    data?: {
      deviceId?: string;
      deviceKey?: string;
      terminalId?: string;
      terminalLabel?: string;
      tenantName?: string;
    };
  };
  const data = body.data ?? {};
  if (!data.deviceId || !data.deviceKey || !data.terminalId) {
    throw new Error('Sunucu eksik eşleştirme bilgisi döndü');
  }

  return {
    deviceId: data.deviceId,
    deviceKey: data.deviceKey,
    terminalId: data.terminalId,
    terminalLabel: data.terminalLabel ?? 'Yazarkasa',
    tenantName: data.tenantName ?? '',
  };
}

function origin(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/$/, '');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sunucunun söylediği sebebi kurulumcuya taşır.
 *
 * Eskiden yalnızca durum kodu loglanıyordu — `"Köprü token'ı alınamadı (409)"`.
 * O satır, sunucuda `BRIDGE_JWT_SECRET` tanımlı olmadığında dakikalarca
 * tekrarlanıyor ve sebebini hiçbir yerde söylemiyordu; oysa API cevabın
 * gövdesinde tam olarak bunu yazıyor. Kurulumu yapan kişi kasada duruyor,
 * sunucunun log'una bakamıyor: mesaj onun görebildiği yere ulaşmalı.
 *
 * Gövde okunamazsa durum koduna düşüyor — teşhis mesajı, teşhis edilmesi
 * gereken ikinci bir arıza kaynağı olmamalı.
 */
async function reason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      message?: unknown;
      error?: { message?: unknown };
    };
    const text = body.error?.message ?? body.message;
    if (typeof text === 'string' && text.trim()) return `${text} (${res.status})`;
  } catch {
    // Gövde yok ya da JSON değil.
  }
  return `HTTP ${res.status}`;
}
