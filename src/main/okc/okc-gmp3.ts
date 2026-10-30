import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type {
  OkcConfig,
  OkcDiagnosticRow,
  OkcDiagnostics,
  OkcHealth,
  OkcIdentityProbe,
  OkcSaleRequest,
  OkcSaleResult,
} from '../../shared/types';
import { atomicWrite } from '../fsutil';
import { log } from '../logger';
import type { DailyZResult, FiscalDevice } from './device';
import { Gmp3DocumentError, planGmp3Sale, type Gmp3Department } from './gmp3-document';
import { Gmp3Helper, helperPath, isUncertain, type Gmp3Reply, type Gmp3Transport } from './gmp3-helper';
import {
  Gmp3Status,
  amountToMinor,
  errorCode,
  errorText,
  hasOpenDocument,
  lastDocumentOf,
  minorToAmount,
  parseResponse,
  receiptNoOf,
  statusText,
  type Gmp3LastDocument,
  type Gmp3Response,
} from './gmp3-protocol';

/**
 * Yazarkasa yöneticisi — kablolu Hugin'in GMP-3 yolu (T300).
 *
 * PC Link yöneticisiyle (`okc.ts`) AYNI SÖZLEŞME, aynı üç sonuç: onaylandı,
 * reddedildi, BİLMİYORUM. Fark dilde: burada cihaz belge kimliği vermiyor ve
 * fiş adım adım ilerliyor (kalemler → kart → kapat), yani "neredeydik"
 * sorusunun cevabı diske yazılan AŞAMA ile cihazın kendi DURUM kodu.
 *
 * KURAL — PC Link'le aynı:
 *  - Cihaza hiç gitmemiş istek (`usage`, `not_connected`) güvenle RET.
 *  - Cevabı kaybolan istek BİLMİYORUM; kayıt diskte kalır, karar kasiyerin.
 *  - Kart ÇEKİLMİŞ OLABİLECEK bir belge kendiliğinden iptal edilmez.
 *
 * KAYNAK: huginsdk/fpu wiki → Satış/Yardımcı/Rapor fonksiyonları; Hugin
 * entegrasyon ekibinin teknik notu: `PrintJSONDocumentDeptOnly` belgeyi
 * kendisi başlatır, `PrintDocumentHeader` gerekmez.
 */

const HEALTH_INTERVAL_MS = 60_000;
/** Kısım/KDV tablosu nadiren değişir; satış hatası (71/72/113) tazeler. */
const TABLES_TTL_MS = 10 * 60_000;
const TIMEOUT = {
  connect: 30_000,
  read: 15_000,
  print: 60_000,
  /** Müşteri kartını okutuyor, şifre giriyor. */
  card: 180_000,
  close: 60_000,
  void: 30_000,
  /** Backend'in beklediği süreyle (90 sn) aynı hizada — bkz. `okc.ts`. */
  dailyZ: 85_000,
} as const;
const TABLE_ERRORS = new Set([71, 72, 112, 113]);

type Phase = 'items' | 'card' | 'close';

interface PendingSale {
  saleId: string;
  document: Record<string, unknown>;
  startedAt: string;
  phase: Phase;
  cardAmountMinor: number | null;
  /** Satıştan önceki son belge — kurtarmada "yeni fiş çıktı mı" sorusu için. */
  before: Gmp3LastDocument | null;
}

type Step =
  | { kind: 'ok'; response: Gmp3Response }
  /**
   * Cihaz cevap verip reddetti (`sent: true`) ya da istek cihaza HİÇ GİTMEDİ
   * (`sent: false` — bağlantı yok, eşleme yok). İkincisinde açık belge de yok.
   */
  | { kind: 'refused'; sent: boolean; error: string; code?: string; response?: Gmp3Response }
  /** Gitti, cevap gelmedi. */
  | { kind: 'unknown'; error: string };

export class Gmp3OkcManager extends EventEmitter implements FiscalDevice {
  private health: OkcHealth = { configured: false };
  private healthTimer: NodeJS.Timeout | null = null;
  private readonly pendingPath: string;
  private readonly logDir: string;
  private readonly transport: Gmp3Transport;
  /** Bu bilgisayarda çalışamıyorsa sebebi (Windows dışı, yardımcı yok). */
  private readonly unsupported: string | null;
  private connected = false;
  private tables: { departments: Gmp3Department[]; loadedAt: number } | null = null;
  private busy = false;
  /** Kart çekilirken bekleyen satış — iptalin kimlik kontrolü için. */
  private active: { saleId: string; phase: Phase } | null = null;

  constructor(
    dataDir: string,
    private config: OkcConfig | undefined,
    private readonly persist: (config: OkcConfig) => void,
    transport?: Gmp3Transport,
  ) {
    super();
    // PC Link'in kaydından AYRI dosya: o kayıt bir `documentId` taşır, bu taşımaz.
    this.pendingPath = path.join(dataDir, 'okc-gmp3-pending.json');
    this.logDir = path.join(dataDir, 'hugin-fpu-logs');
    if (transport) {
      this.transport = transport;
      this.unsupported = null;
    } else {
      const exe = helperPath();
      this.transport = new Gmp3Helper(exe);
      this.unsupported =
        process.platform !== 'win32'
          ? "T300 (GMP-3) yalnız Windows'ta çalışır"
          : fs.existsSync(exe)
            ? null
            : 'Bu ajan sürümünde T300 (GMP-3) desteği yok';
    }
    this.health = { configured: Boolean(config) };
  }

  // --- yapılandırma -------------------------------------------------------

  getConfig(): OkcConfig | undefined {
    return this.config;
  }

  setConfig(config: OkcConfig | undefined): void {
    const previous = this.config;
    this.config = config;
    if (
      !config ||
      !previous ||
      config.host !== previous.host ||
      config.port !== previous.port ||
      config.serialNo !== previous.serialNo
    ) {
      // Başka cihaz ya da başka sicil: eşleme ve tablolar o cihaza aitti.
      this.disconnect();
    }
    this.health = { configured: Boolean(config) };
    void this.refreshHealth();
  }

  getHealth(): OkcHealth {
    return this.health;
  }

  start(): void {
    this.healthTimer = setInterval(() => void this.refreshHealth(), HEALTH_INTERVAL_MS);
    void this.refreshHealth();
  }

  stop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.transport.close();
    this.connected = false;
  }

  /**
   * `CheckPrinterStatus` — kasa ekranındaki göstergenin dayanağı.
   *
   * SATIŞ SÜRERKEN SORULMAZ. Yardımcı program istekleri sıraya diziyor; kart
   * beklenirken atılan bir durum sorgusu üç dakika sırada bekler ve o sürede
   * gösterge "denetleniyor"da donar. Satış zaten cihazın durumunu biliyor.
   */
  async refreshHealth(): Promise<OkcHealth> {
    if (this.busy) return this.health;
    const previous = this.health;
    const base = { configured: Boolean(this.config), pendingSale: this.readPending()?.saleId };

    if (!this.config) {
      this.health = { configured: false };
    } else if (this.unsupported) {
      this.health = { ...base, ok: false, error: this.unsupported, checkedAt: now() };
    } else {
      const step = await this.call('status', {}, TIMEOUT.read);
      if (step.kind === 'ok') {
        const status = step.response.status;
        const open = hasOpenDocument(status);
        this.health = {
          ...base,
          ok: step.response.error === 0,
          state: statusText(status),
          hasOpenDocument: open,
          // Kaydı olmayan açık belge de kapatılabilmeli (`cancelPending`):
          // GMP-3'te belge kimliği yok, işaret yeterli.
          ...(open && !base.pendingSale ? { openDocumentId: 'GMP3' } : {}),
          ...(step.response.error !== 0 ? { error: errorText(step.response.error) } : {}),
          checkedAt: now(),
        };
      } else {
        this.health = { ...base, ok: false, error: step.error, checkedAt: now() };
      }
    }

    if (this.health.error && this.health.error !== previous.error) {
      log.warn('okc gmp3 sağlık hatası', { error: this.health.error });
    } else if (!this.health.error && previous.error) {
      log.info('okc gmp3 sağlık düzeldi');
    }
    this.emit('changed');
    return this.health;
  }

  // --- satış --------------------------------------------------------------

  async sell(request: OkcSaleRequest): Promise<OkcSaleResult> {
    if (!this.config) return declined(request.saleId, 'Yazarkasa tanımlanmadı');
    if (this.unsupported) return declined(request.saleId, this.unsupported);
    if (this.busy) return declined(request.saleId, 'Yazarkasa meşgul');

    this.busy = true;
    try {
      return await this.runSale(request);
    } finally {
      this.busy = false;
      this.active = null;
      this.emit('changed');
    }
  }

  private async runSale(request: OkcSaleRequest): Promise<OkcSaleResult> {
    const { saleId } = request;

    const departments = await this.departments();
    if (!departments.ok) return declined(saleId, departments.error);

    let plan;
    try {
      plan = planGmp3Sale(request.document, departments.value);
    } catch (err) {
      if (err instanceof Gmp3DocumentError) return declined(saleId, err.message);
      throw err;
    }
    if (plan.droppedQr) log.info('okc gmp3 fiş altı QR basılmadı (cihaz desteklemiyor)', { saleId });

    // Cihaz BOŞTA olmalı. Açık bir belgenin üstüne yeni kalem yazmak, iki
    // adisyonu tek fişe karıştırmaktır.
    const status = await this.call('status', {}, TIMEOUT.read);
    if (status.kind !== 'ok') return declined(saleId, status.error);
    if (status.response.status !== Gmp3Status.IDLE) {
      return declined(saleId, `Yazarkasa satışa hazır değil: ${statusText(status.response.status)}`);
    }

    const before = await this.lastDocument();
    const pending: PendingSale = {
      saleId,
      document: request.document,
      startedAt: now(),
      phase: 'items',
      cardAmountMinor: plan.cardAmountMinor,
      before,
    };
    // Kayıt CİHAZA GİTMEDEN yazılır: buradan sonra çökersek cihazda açık bir
    // belge kalabilir ve onu bulmanın tek yolu bu kayıt.
    this.writePending(pending);

    // 1) Kalemler (+ nakit ödemeler). Kart yoksa belge burada kapanır.
    const items = await this.call('printDeptOnly', { document: plan.document }, TIMEOUT.print);
    if (items.kind === 'unknown') return this.unknown(saleId, items.error);
    if (items.kind === 'refused') {
      if (items.response && TABLE_ERRORS.has(items.response.error)) this.tables = null;
      if (items.sent) await this.closeRefused();
      else this.clearPending();
      return declined(saleId, items.error, items.code);
    }

    // 2) Kart — cihazın kendi EFT-POS'u.
    if (plan.cardAmountMinor !== null) {
      this.writePending({ ...pending, phase: 'card' });
      this.active = { saleId, phase: 'card' };
      const card = await this.call(
        'eft',
        { amount: minorToAmount(plan.cardAmountMinor), installment: 0 },
        TIMEOUT.card,
      );
      this.active = null;
      if (card.kind === 'unknown') return this.unknown(saleId, card.error);
      if (card.kind === 'refused') {
        // Ret = provizyon yok, para çekilmedi. Belge kapatılır ki kasa kilitli kalmasın.
        await this.closeRefused();
        return declined(saleId, card.error, card.code);
      }
      this.writePending({ ...pending, phase: 'close' });
    }

    // 3) Kapat — kart varsa her zaman, yoksa cihaz hâlâ açık tutuyorsa.
    return this.finish(saleId);
  }

  /**
   * Ödemesi tamamlanmış belgeyi kapatır ve fiş numarasını okur.
   *
   * KAPANMAZSA BİLMİYORUM. Kart çekilmiş, belge açık (kağıt bitti) — bu bir ret
   * değil. PC Link'teki `206`'nın karşılığı: kayıt kalır, kasiyer kağıdı takıp
   * "Tekrar dene"ye basar ve aynı belge kapanır.
   */
  private async finish(saleId: string): Promise<OkcSaleResult> {
    const status = await this.call('status', {}, TIMEOUT.read);
    if (status.kind === 'ok' && status.response.status !== Gmp3Status.IDLE) {
      if (status.response.status !== Gmp3Status.OPEN_SALE) {
        // Kalemler ve ödemeler gitti ama cihaz ödemenin tamamlandığını
        // söylemiyor: tutar tutmadı ya da bir ödeme düştü. Belgeyi iptal
        // etmek kartı iade etmez — karar kasiyerin.
        return this.unknown(
          saleId,
          `Ödeme cihazda tamamlanmadı (${statusText(status.response.status)}) — yazarkasayı kontrol edin`,
        );
      }
      const close = await this.call('closeReceipt', { slipCopy: false }, TIMEOUT.close);
      if (close.kind !== 'ok') {
        return this.unknown(saleId, `Ödeme alındı ancak fiş kapatılamadı — ${close.error}`);
      }
    } else if (status.kind !== 'ok') {
      return this.unknown(saleId, status.error);
    }

    const last = await this.lastDocument();
    this.clearPending();
    if (!last) log.warn('okc gmp3 fiş numarası okunamadı', { saleId });
    return {
      saleId,
      status: 'APPROVED',
      ...(last ? { receiptNo: receiptNoOf(last.zNo, last.documentNo) } : {}),
    };
  }

  /**
   * Reddedilen satışın açık belgesini kapatır — yalnızca ÖDEMESİ TAMAMLANMAMIŞ
   * belgeyi. Başarısızsa kayıt kalır ve Yazarkasa paneli belgeyi gösterir.
   */
  private async closeRefused(): Promise<void> {
    const status = await this.call('status', {}, TIMEOUT.read);
    if (status.kind !== 'ok') return;
    if (status.response.status === Gmp3Status.IDLE) {
      this.clearPending();
      return;
    }
    if (!hasOpenDocument(status.response.status) || status.response.status === Gmp3Status.OPEN_SALE) return;
    const voided = await this.call('voidReceipt', {}, TIMEOUT.void);
    if (voided.kind === 'ok') this.clearPending();
    else log.warn('okc gmp3 reddedilen belge iptal edilemedi', { error: voided.error });
  }

  private unknown(saleId: string, error: string): OkcSaleResult {
    log.warn('okc gmp3 satış belirsiz', { saleId, error });
    return { saleId, status: 'UNKNOWN', error };
  }

  /**
   * Kasadan gelen iptal. Kart cihazda beklenirken YAPILAMAZ: kütüphane tek
   * kanal ve o kanal kartı bekliyor. Kasiyer iptali cihazın ekranından yapar;
   * cihaz ret döner ve satış kendi gerçek sonucuyla kapanır.
   */
  async cancelSale(saleId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.active?.saleId === saleId) {
      return { ok: false, error: 'Kart işlemi yazarkasada sürüyor — iptali yazarkasanın ekranından yapın' };
    }
    if (this.readPending()?.saleId !== saleId) return { ok: false, error: 'Bu satış cihazda beklemiyor' };
    return this.cancelPending();
  }

  /**
   * Yarım kalmış belgeyi iptal eder — kasiyerin bilinçli kararı.
   *
   * ÖDEMESİ TAMAMLANMIŞ BELGE İPTAL EDİLMEZ: kart çekilmiş demektir ve belgeyi
   * iptal etmek parayı iade etmez, yalnızca mali karşılığını siler. O durumda
   * yapılacak şey "Tekrar dene" ile kapatmak.
   */
  async cancelPending(): Promise<{ ok: boolean; error?: string }> {
    if (!this.config) return { ok: false, error: 'Yazarkasa tanımlanmadı' };
    if (this.busy) return { ok: false, error: 'Yazarkasa meşgul' };
    this.busy = true;
    try {
      const status = await this.call('status', {}, TIMEOUT.read);
      if (status.kind !== 'ok') return { ok: false, error: status.error };
      const state = status.response.status;
      if (state === Gmp3Status.IDLE) {
        // Cihazda açık belge yok: kayıt yalnızca bizde kalmış.
        this.clearPending();
        return { ok: true };
      }
      if (state === Gmp3Status.OPEN_SALE) {
        return { ok: false, error: "Ödeme alınmış — iptal yerine 'Tekrar dene' ile fişi kapatın" };
      }
      if (!hasOpenDocument(state)) return { ok: false, error: statusText(state) };
      const voided = await this.call('voidReceipt', {}, TIMEOUT.void);
      if (voided.kind !== 'ok') return { ok: false, error: voided.error };
      this.clearPending();
      log.info('okc gmp3 bekleyen belge iptal edildi');
      return { ok: true };
    } finally {
      this.busy = false;
      void this.refreshHealth();
    }
  }

  /**
   * Yarım kalan satışı CİHAZIN DURUMUNA GÖRE sürdürür.
   *
   *  - Ödeme tamam, belge açık  → kapat (kağıt takıldıktan sonraki yol).
   *  - Kart bekliyor            → kartı yeniden iste. Cihaz ödemeyi kaydetmemiş
   *                               demek; kasiyer "Tekrar dene"ye bastı.
   *  - Kalemler yarım           → sürdürülemez, iptal kasiyerin.
   *  - Cihaz boşta              → belge cihazda kapanmış ya da iptal edilmiş;
   *                               hangisi olduğunu GMP-3 söylemiyor. Fişe bakmak
   *                               kasiyerin işi, biz "onaylandı" uydurmayız.
   */
  async retryPending(): Promise<OkcSaleResult | null> {
    const pending = this.readPending();
    if (!pending || this.busy || !this.config) return null;

    this.busy = true;
    try {
      const status = await this.call('status', {}, TIMEOUT.read);
      if (status.kind !== 'ok') return this.unknown(pending.saleId, status.error);
      const state = status.response.status;

      if (state === Gmp3Status.OPEN_SALE) return await this.finish(pending.saleId);

      if (state === Gmp3Status.PAYMENT && pending.cardAmountMinor !== null) {
        this.writePending({ ...pending, phase: 'card' });
        const card = await this.call(
          'eft',
          { amount: minorToAmount(pending.cardAmountMinor), installment: 0 },
          TIMEOUT.card,
        );
        if (card.kind === 'unknown') return this.unknown(pending.saleId, card.error);
        if (card.kind === 'refused') {
          // `runSale` ile aynı: ret = para çekilmedi, belge kapatılır.
          await this.closeRefused();
          return declined(pending.saleId, card.error, card.code);
        }
        this.writePending({ ...pending, phase: 'close' });
        return await this.finish(pending.saleId);
      }

      if (state === Gmp3Status.IDLE) {
        const last = await this.lastDocument();
        const moved =
          last && pending.before
            ? last.zNo !== pending.before.zNo || last.documentNo !== pending.before.documentNo
            : null;
        return this.unknown(
          pending.saleId,
          moved && last
            ? `Cihazda açık belge yok; son belge ${receiptNoOf(last.zNo, last.documentNo)} — fişi kontrol edip kaydı kaldırın`
            : 'Cihazda açık belge yok ve yeni fiş görünmüyor — kaydı kaldırabilirsiniz',
        );
      }

      return this.unknown(
        pending.saleId,
        `Belge yarım kaldı (${statusText(state)}) — 'Belgeyi iptal et' ile kapatın`,
      );
    } finally {
      this.busy = false;
      this.emit('changed');
    }
  }

  // --- gün sonu -----------------------------------------------------------

  /**
   * Z raporu. ÖNCE günün özeti okunur (`GetDailySummary`): `PrintZReport`
   * yalnızca belge ve Z numarasını döndürüyor, backend ise ciro/KDV/nakit/kart
   * bekliyor. Özet Z'den SONRA sıfırlanır — sıra ters olamaz.
   *
   * Cevapsız Z "alınmadı" değildir: günde bir kez ve geri alınamaz (bkz. `okc.ts`).
   */
  async dailyZ(): Promise<DailyZResult> {
    if (!this.config) return { ok: false, error: 'Yazarkasa tanımlanmadı' };
    if (this.unsupported) return { ok: false, error: this.unsupported };
    if (this.busy) return { ok: false, error: 'Cihaz satış işlemiyle meşgul' };

    this.busy = true;
    try {
      const summary = await this.dailySummary();
      const z = await this.call('zReport', {}, TIMEOUT.dailyZ);
      if (z.kind !== 'ok') {
        log.warn('okc gmp3 gün sonu alınamadı', { error: z.error, uncertain: z.kind === 'unknown' });
        return { ok: false, error: z.error };
      }

      const documentNo = Number.parseInt(z.response.params[0] ?? '', 10);
      const zNo = Number.parseInt(z.response.params[1] ?? '', 10);
      const serialNo = this.config.serialNo;
      log.info('okc gmp3 gün sonu alındı', { zNo });
      return {
        ok: true,
        report: {
          // PC Link Z raporunun alan adları — backend aynı okuyucuyla kaydediyor
          // (`readHuginZReport`).
          reportHeader: {
            receiptNo: Number.isFinite(zNo) && Number.isFinite(documentNo) ? receiptNoOf(zNo, documentNo) : '',
            ...(serialNo ? { deviceId: serialNo } : {}),
          },
          ...(summary
            ? {
                grossSales: { total: minorToAmount(summary.validMinor) },
                topSat: minorToAmount(summary.validMinor),
                topKdv: minorToAmount(summary.vatMinor),
                cash: { total: minorToAmount(summary.cashMinor) },
                eftPos: { total: minorToAmount(summary.creditMinor) },
              }
            : {}),
          gmp3: { zResponse: z.response.raw, summary: summary?.raw ?? null },
        },
        ...(serialNo ? { serialNo } : {}),
      };
    } finally {
      this.busy = false;
      void this.refreshHealth();
    }
  }

  private async dailySummary(): Promise<{
    validMinor: number;
    vatMinor: number;
    cashMinor: number;
    creditMinor: number;
    raw: unknown;
  } | null> {
    const reply = await this.request('dailySummary', {}, TIMEOUT.read);
    if (!reply.ok || !reply.raw) return null;
    let parsed: { summaries?: Record<string, unknown>[] };
    try {
      parsed = JSON.parse(reply.raw) as typeof parsed;
    } catch {
      // JSON değilse "hata|durum" döndü: özet yok, Z yine alınır.
      log.warn('okc gmp3 gün özeti okunamadı', { raw: reply.raw.slice(0, 40) });
      return null;
    }
    const sum = (field: string): number =>
      (parsed.summaries ?? []).reduce((total, row) => {
        const value = row[field];
        return total + (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : 0);
      }, 0);
    return {
      validMinor: sum('ValidAmount'),
      vatMinor: sum('VatTotal'),
      cashMinor: sum('Cash'),
      creditMinor: sum('Credit'),
      raw: parsed,
    };
  }

  // --- kurulum ------------------------------------------------------------

  /** PC Link'in kimlik keşfi GMP-3'te yok: eşleme sicil numarasıyla yapılıyor. */
  async discoverIdentity(): Promise<OkcIdentityProbe> {
    return { accepted: null, tried: [] };
  }

  /**
   * TANILAMA — salt okunur: sürüm, durum, son belge, kısım/KDV tablosu.
   * Kısım tablosu satışın KDV doğruluğunun dayanağı; kurulumda görülmesi gerek.
   */
  async diagnose(): Promise<OkcDiagnostics> {
    const rows: OkcDiagnosticRow[] = [];
    const row = (label: string, endpoint: string, reply: Gmp3Reply): void => {
      const response = reply.ok && reply.raw ? parseResponse(reply.raw) : null;
      const ok = Boolean(response && response.error === 0);
      rows.push({
        label,
        endpoint,
        headers: {},
        httpStatus: ok ? 200 : 0,
        ok,
        ...(response && response.error !== 0 ? { code: errorCode(response.error) } : {}),
        message: reply.ok ? (reply.raw ?? '') : (reply.error ?? 'Cevap yok'),
      });
    };

    if (this.unsupported || !this.config || this.busy) {
      return { rows, accepted: null };
    }
    const connect = await this.connect();
    rows.push({
      label: 'Eşleme',
      endpoint: 'connect',
      headers: { sicil: this.config.serialNo ?? '' },
      httpStatus: connect.ok ? 200 : 0,
      ok: connect.ok,
      message: connect.ok ? `Kütüphane ${connect.library ?? '?'}` : (connect.error ?? 'Eşleşmedi'),
    });
    if (!connect.ok) return { rows, accepted: null };

    row('Cihaz sürümü', 'version', await this.request('version', {}, TIMEOUT.read));
    row('Durum', 'status', await this.request('status', {}, TIMEOUT.read));
    row('Son belge', 'lastDocument', await this.request('lastDocument', { lastZ: false }, TIMEOUT.read));
    this.tables = null;
    const departments = await this.departments();
    rows.push({
      label: 'Kısım / KDV',
      endpoint: 'department',
      headers: {},
      httpStatus: departments.ok ? 200 : 0,
      ok: departments.ok,
      message: departments.ok
        ? departments.value.map((dept) => `Kısım ${dept.deptId}: %${dept.vatRate}`).join(', ') || 'Tanımlı kısım yok'
        : departments.error,
    });
    return {
      rows,
      accepted: connect.ok ? 'GMP-3' : null,
      ...(this.config.serialNo ? { deviceSerialNo: this.config.serialNo } : {}),
    };
  }

  // --- cihazla konuşma ----------------------------------------------------

  private async connect(): Promise<Gmp3Reply> {
    const config = this.config;
    if (!config?.serialNo) {
      return { ok: false, kind: 'usage', error: 'Yazarkasanın sicil numarasını girin' };
    }
    const reply = await this.transport.request(
      'connect',
      {
        host: config.host,
        port: config.port,
        fiscalRegNo: config.serialNo,
        logDir: this.logDir,
        connectTimeoutMs: 5000,
      },
      TIMEOUT.connect,
    );
    this.connected = reply.ok;
    if (!reply.ok) {
      log.warn('okc gmp3 bağlanamadı', { kind: reply.kind, error: reply.error, detail: reply.detail });
    }
    return reply;
  }

  /**
   * Bağlı değilsek önce bağlanır. `not_connected` cihaza hiçbir şey
   * gitmediği anlamına geldiği için o durumda BİR KEZ yeniden bağlanıp
   * tekrarlamak güvenli — para çağrısında da.
   */
  private async request(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<Gmp3Reply> {
    if (!this.connected) {
      const connect = await this.connect();
      if (!connect.ok) return notSent(connect);
    }
    let reply = await this.transport.request(cmd, args, timeoutMs);
    if (!reply.ok && reply.kind === 'not_connected') {
      this.connected = false;
      const connect = await this.connect();
      if (!connect.ok) return notSent(connect);
      reply = await this.transport.request(cmd, args, timeoutMs);
    }
    if (isUncertain(reply)) this.connected = false;
    return reply;
  }

  /** İstek + cevabın üç sonuca indirgenmesi. */
  private async call(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<Step> {
    const reply = await this.request(cmd, args, timeoutMs);
    if (isUncertain(reply)) return { kind: 'unknown', error: reply.error ?? 'Yazarkasa cevap vermedi' };
    if (!reply.ok) {
      return { kind: 'refused', sent: false, error: reply.error ?? 'Yazarkasa isteği kabul etmedi' };
    }
    const response = reply.raw ? parseResponse(reply.raw) : null;
    if (!response) {
      // Cihaz bir şey söyledi ama okunamıyor. Okunamayan cevabı "ret" saymak,
      // belki onaylanmış bir ödemeyi reddedilmiş yazmak olurdu.
      return { kind: 'unknown', error: 'Yazarkasa cevabı okunamadı' };
    }
    if (response.error !== 0) {
      return {
        kind: 'refused',
        sent: true,
        error: errorText(response.error),
        code: errorCode(response.error),
        response,
      };
    }
    return { kind: 'ok', response };
  }

  private async lastDocument(): Promise<Gmp3LastDocument | null> {
    const step = await this.call('lastDocument', { lastZ: false }, TIMEOUT.read);
    return step.kind === 'ok' ? lastDocumentOf(step.response) : null;
  }

  /**
   * Cihazın kısım → KDV tablosu. Kısmın KDV GRUBU `GetVATRate`'in indeksiyle
   * eşleniyor (belge: kısım `KDVGrupID`, oran `GetVATRate(0..7)`).
   */
  private async departments(): Promise<{ ok: true; value: Gmp3Department[] } | { ok: false; error: string }> {
    if (this.tables && Date.now() - this.tables.loadedAt < TABLES_TTL_MS) {
      return { ok: true, value: this.tables.departments };
    }

    // On altı okuma var. Bağlantı yoksa (ya da cevap kaybolduysa) İLK
    // okumada durulur: her biri ayrı bir bağlanma denemesi olsaydı, kapalı
    // bir cihazda satış ret almadan önce bir buçuk dakika beklerdi.
    const unreachable = (step: Step): string | null =>
      step.kind === 'unknown' || (step.kind === 'refused' && !step.sent) ? step.error : null;

    const rates = new Map<number, number>();
    for (let index = 0; index <= 7; index += 1) {
      const step = await this.call('vatRate', { index }, TIMEOUT.read);
      const stop = unreachable(step);
      if (stop) return { ok: false, error: stop };
      if (step.kind !== 'ok') continue;
      const rate = percentOf(step.response.params[0]);
      if (rate !== null) rates.set(index, rate);
    }

    const departments: Gmp3Department[] = [];
    for (let deptId = 1; deptId <= 8; deptId += 1) {
      const step = await this.call('department', { deptId }, TIMEOUT.read);
      const stop = unreachable(step);
      if (stop) return { ok: false, error: stop };
      if (step.kind !== 'ok') continue;
      const [name, group] = step.response.params;
      const vatRate = rates.get(Number.parseInt(group ?? '', 10));
      if (name && vatRate !== undefined) departments.push({ deptId, vatRate });
    }

    if (departments.length === 0) {
      return { ok: false, error: 'Yazarkasada KDV oranlı kısım okunamadı' };
    }
    this.tables = { departments, loadedAt: Date.now() };
    log.info('okc gmp3 kısım tablosu okundu', {
      departments: departments.map((dept) => `${dept.deptId}:%${dept.vatRate}`).join(' '),
    });
    return { ok: true, value: departments };
  }

  private disconnect(): void {
    this.transport.close();
    this.connected = false;
    this.tables = null;
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
 * KDV oranı metni → tam yüzde. Cihaz `"10"`, `"10,00"` ya da `"10.00"`
 * yazabilir. Küsuratlı oran (%8,5) TAM SAYIYA YUVARLANMAZ — öyle bir kısım
 * hiçbir kalemle eşleşmez ve satış o kısma hiç yazılmaz.
 */
function percentOf(text: string | undefined): number | null {
  const minor = amountToMinor(text);
  return minor === null || minor < 0 ? null : minor / 100;
}

/**
 * Bağlanılamadı → asıl istek cihaza HİÇ GİTMEDİ. Bağlantının kendi zaman
 * aşımı "belirsiz" görünse de para çağrısı için belirsizlik yok.
 */
function notSent(connect: Gmp3Reply): Gmp3Reply {
  return {
    ok: false,
    kind: 'not_connected',
    error: connect.error ?? 'Yazarkasaya bağlanılamadı',
    ...(connect.detail ? { detail: connect.detail } : {}),
  };
}

function declined(saleId: string, error: string, code?: string): OkcSaleResult {
  return { saleId, status: 'DECLINED', error, ...(code ? { code } : {}) };
}

function now(): string {
  return new Date().toISOString();
}
