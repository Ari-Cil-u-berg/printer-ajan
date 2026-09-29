import { EventEmitter } from 'node:events';
import { STATIONS } from '../shared/types';
import { isStation } from '../shared/types';
import type {
  AgentConfig,
  ConnectionState,
  BridgePairing,
  OkcConfig,
  OkcSaleResult,
  PairingView,
  PrinterConfig,
  PrinterPairing,
  PrintJob,
  StatusSnapshot,
  Station,
} from '../shared/types';
import { isAutostartEnabled, setAutostart } from './autostart';
import { ConfigStore } from './config-store';
import { ConnectionManager } from './connection';
import { envConfig } from './env';
import { log } from './logger';
import { deviceInfo, heartbeat, pair } from './pairing';
import { BridgeLink, pairBridge } from './bridge/bridge-link';
import { OkcManager } from './okc/okc';
import { PrintEngine } from './print/engine';
import { JobQueue } from './queue';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const PROBE_INTERVAL_MS = 60 * 1000;

/** Wires config + queue + engine + connection together and owns the status snapshot. */
export class Agent extends EventEmitter {
  readonly config: ConfigStore;
  private readonly queue: JobQueue;
  private readonly engine: PrintEngine;
  /** One socket per printer pairing, keyed by its deviceId. */
  private readonly connections = new Map<string, ConnectionManager>();
  private readonly connectionStates = new Map<string, ConnectionState>();
  private readonly pairingHealth = new Map<string, NonNullable<PairingView['health']>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private lastJob: StatusSnapshot['lastJob'];
  private printerHealth: StatusSnapshot['printerHealth'] = {};
  private lastSale: StatusSnapshot['lastSale'];
  readonly okc: OkcManager;
  private bridge: BridgeLink | null = null;

  constructor(private readonly appVersion: string) {
    super();
    this.config = new ConfigStore();
    this.engine = new PrintEngine((job) => this.printerFor(job));
    this.queue = new JobQueue(this.config.dataDir(), (job) => this.engine.print(job));
    this.okc = new OkcManager(this.config.dataDir(), this.config.get().okc, (okc) =>
      this.config.update({ okc }),
    );
    this.okc.on('changed', () => this.emitStatus());

    this.queue.on('ack', (ack, job: PrintJob | undefined) => {
      this.lastJob = {
        jobId: ack.jobId,
        station: job?.station ?? this.lastJob?.station ?? 'BAR',
        status: ack.status === 'printed' ? 'Yazdırıldı' : 'Başarısız',
        at: new Date().toISOString(),
        error: ack.error,
      };
      // The ack goes back on the socket of the printer record that sent the
      // job — the backend only accepts it from that device. A job from before
      // pairings (no route) belonged to the single migrated pairing.
      const route = job?.route ?? this.config.get().pairings.find((p) => p.legacyStationMap)?.deviceId;
      if (route) this.connections.get(route)?.ack(ack);
      this.emitStatus();
    });
    this.queue.on('changed', () => this.emitStatus());
    this.queue.on('failure', (job: PrintJob, error: string) => {
      this.lastJob = {
        jobId: job.jobId,
        station: job.station,
        status: 'Yeniden denenecek',
        at: new Date().toISOString(),
        error,
      };
      this.emitStatus();
    });
  }

  // --- lifecycle ----------------------------------------------------------

  start(): void {
    setAutostart(this.config.get().autostart);
    this.queue.start();
    this.okc.start();
    this.connectAll();
    this.startHeartbeat();
    void this.connectBridge();
    this.probeTimer = setInterval(() => void this.refreshPrinterHealth(), PROBE_INTERVAL_MS);
    void this.refreshPrinterHealth();
  }

  stop(): void {
    this.queue.stop();
    this.okc.stop();
    this.bridge?.stop();
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.probeTimer) clearInterval(this.probeTimer);
  }

  // --- printer pairings ----------------------------------------------------

  private connectAll(): void {
    for (const pairing of this.config.get().pairings) this.connectPairing(pairing);
    this.emitStatus();
  }

  private connectPairing(pairing: PrinterPairing): void {
    const token = this.config.getToken(pairing.deviceId);
    if (!token) {
      // A row without its token cannot authenticate and never will; drop it
      // rather than show a printer that looks paired and never prints.
      log.warn('pairing has no token — removing', { deviceId: pairing.deviceId });
      this.config.removePairing(pairing.deviceId);
      return;
    }
    const cfg = this.config.get();
    this.connections.get(pairing.deviceId)?.close();

    const conn = new ConnectionManager({
      wsUrl: cfg.wsUrl,
      token,
      deviceInfo: deviceInfo(this.appVersion, cfg.deviceName),
      dataDir: this.config.dataDir(),
      queuedCount: () => this.queue.size(),
      outboxName: `ack-outbox-${pairing.deviceId}.json`,
    });
    conn.on('state', (state: ConnectionState) => {
      this.connectionStates.set(pairing.deviceId, state);
      this.emitStatus();
    });
    conn.on('job', (job: PrintJob) => {
      // Stamped here, never trusted from the wire: this decides the printer.
      const routed: PrintJob = { ...job, route: pairing.deviceId };
      log.info('job received', { jobId: job.jobId, station: job.station, printer: pairing.printerName });
      this.lastJob = { jobId: job.jobId, station: job.station, status: 'Kuyrukta', at: new Date().toISOString() };
      this.queue.enqueue(routed);
    });
    conn.on('connected', () => this.queue.pumpAll());
    conn.on('unauthorized', () => {
      // Revoked from the panel: this printer only. The others keep printing.
      log.warn('token rejected — removing pairing', { printer: pairing.printerName });
      this.connections.delete(pairing.deviceId);
      this.connectionStates.delete(pairing.deviceId);
      this.config.removePairing(pairing.deviceId);
      this.emitStatus();
      this.emit('unauthorized', pairing.printerName);
    });
    this.connections.set(pairing.deviceId, conn);
    this.connectionStates.set(pairing.deviceId, 'CONNECTING');
    conn.connect();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const cfg = this.config.get();
      for (const pairing of cfg.pairings) {
        const token = this.config.getToken(pairing.deviceId);
        if (token) void heartbeat(cfg.apiBaseUrl, token, this.appVersion);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** The local printer a job goes to, and what to call it if there is none. */
  private printerFor(job: PrintJob): { printer: PrinterConfig | undefined; label: string } {
    const cfg = this.config.get();
    const pairing = job.route
      ? cfg.pairings.find((p) => p.deviceId === job.route)
      : cfg.pairings.find((p) => p.legacyStationMap);
    if (pairing && !pairing.legacyStationMap) {
      return { printer: pairing.local, label: pairing.printerName };
    }
    return { printer: cfg.printers[job.station], label: `${job.station} istasyonu` };
  }

  /** Aggregate for the header: connected only when EVERY printer is. */
  private aggregateState(): ConnectionState {
    const pairings = this.config.get().pairings;
    if (pairings.length === 0) return 'UNPAIRED';
    const states = pairings.map((p) => this.connectionStates.get(p.deviceId) ?? 'CONNECTING');
    if (states.every((st) => st === 'CONNECTED')) return 'CONNECTED';
    if (states.some((st) => st === 'CONNECTING')) return 'CONNECTING';
    return 'OFFLINE';
  }

  // --- actions used by IPC ------------------------------------------------

  /**
   * Adds ONE printer record. Every printer on the panel has its own code; a
   * till with a kasa and a mutfak printer is paired twice. Re-entering a code
   * for a printer already here replaces that pairing (a fresh code after a
   * revoke) and keeps its local printer.
   */
  async pairWithCode(code: string): Promise<PrinterPairing> {
    const cfg = this.config.get();
    const result = await pair(cfg.apiBaseUrl, code, deviceInfo(this.appVersion, cfg.deviceName));

    // One till serves one café. A code from another tenant is almost always a
    // mix-up at the counter, and silently printing a stranger's tickets here is
    // the worst way to find out.
    const other = cfg.pairings.find((p) => p.tenantId !== result.tenantId);
    if (other) {
      throw new Error(
        `Bu bilgisayar "${other.tenantName}" işletmesine bağlı. Başka bir işletmenin kodu eklenemez.`,
      );
    }

    const existing = cfg.pairings.find((p) => p.deviceId === result.deviceId);
    const pairing: PrinterPairing = {
      deviceId: result.deviceId,
      printerName: result.printerName ?? result.branchName ?? 'Yazıcı',
      stations: (result.stations ?? []).filter(isStation),
      tenantId: result.tenantId,
      branchId: result.branchId,
      tenantName: result.tenantName,
      branchName: result.branchName,
      pairedAt: new Date().toISOString(),
      ...(existing?.local ? { local: existing.local } : {}),
    };
    this.config.setToken(result.deviceId, result.deviceToken);
    this.config.update({
      pairings: [...cfg.pairings.filter((p) => p.deviceId !== result.deviceId), pairing],
    });
    log.info('paired', { tenant: result.tenantName, printer: pairing.printerName });
    this.connectPairing(pairing);
    this.emitStatus();
    return pairing;
  }

  /** Removes one printer pairing — or all of them when no id is given. */
  unpair(deviceId?: string): void {
    const targets = deviceId
      ? [deviceId]
      : this.config.get().pairings.map((p) => p.deviceId);
    for (const id of targets) {
      this.connections.get(id)?.close();
      this.connections.delete(id);
      this.connectionStates.delete(id);
      this.pairingHealth.delete(id);
      this.config.removePairing(id);
    }
    this.emitStatus();
  }

  /** Which local printer a paired printer record prints to. */
  setPairingPrinter(deviceId: string, printer: PrinterConfig | undefined): AgentConfig {
    const pairings = this.config.get().pairings.map((p) => {
      if (p.deviceId !== deviceId) return p;
      const { local: _old, ...rest } = p;
      // Choosing a printer for a migrated pairing moves it onto the new model.
      const { legacyStationMap: _legacy, ...modern } = rest;
      return printer ? { ...modern, local: printer } : rest;
    });
    const cfg = this.config.update({ pairings });
    void this.refreshPrinterHealth();
    this.queue.pumpAll(); // a fixed printer should drain the backlog immediately
    return cfg;
  }

  /** Station map — only a pairing migrated from ≤0.3.21 still reads it. */
  setPrinter(station: Station, printer: PrinterConfig | undefined): AgentConfig {
    const printers = { ...this.config.get().printers };
    if (printer) printers[station] = printer;
    else delete printers[station];
    const cfg = this.config.update({ printers });
    void this.refreshPrinterHealth();
    this.queue.pumpAll();
    return cfg;
  }

  private recordSale(result: OkcSaleResult): void {
    this.lastSale = { ...result, at: new Date().toISOString() };
    this.emitStatus();
  }

  // --- ödeme köprüsü ------------------------------------------------------

  /**
   * Köprüyü açar. Eşleştirme ya da anahtar yoksa SESSİZCE durur.
   *
   * Köprü isteğe bağlı: ÖKC'si olmayan kafede yalnızca yazıcı ajanı çalışır ve
   * bağlanmayan bir soket için hata göstermek, olmayan bir sorunu bildirmek olur.
   */
  private async connectBridge(): Promise<void> {
    this.bridge?.stop();
    this.bridge = null;

    const cfg = this.config.get();
    const key = this.config.getBridgeKey();
    if (!cfg.bridge || !key) {
      this.emitStatus();
      return;
    }

    const link = new BridgeLink({
      apiBaseUrl: cfg.apiBaseUrl,
      pairing: cfg.bridge,
      deviceKey: key,
      agentVersion: this.appVersion,
      sell: async (input) => {
        const result = await this.okc.sell(input);
        this.recordSale(result);
        return result;
      },
      // Yalnızca BİZİM işlemimiz sorulur; başka bir satışın sonucu buradan
      // dönmez (bkz. `BridgeLink.onQuery`).
      lookup: (saleId) =>
        this.lastSale && this.lastSale.saleId === saleId ? this.lastSale : null,
      reachable: () => this.okc.getHealth().ok === true,
      // Kimlik kontrolü `OkcManager` tarafında: yalnızca adı geçen satış
      // iptal edilir, arada başlamış başka bir adisyonunki değil.
      cancelSale: (saleId) => this.okc.cancelSale(saleId),
      // Gün sonu SUNUCUDAN emredilir. Ajanın kendi zamanlayıcısı yok ve
      // olmamalı: mali günü kapatmak kafenin kararı.
      dailyZ: () => this.okc.dailyZ(),
      serialNo: () => this.okc.getConfig()?.serialNo,
    });

    link.on('changed', () => this.emitStatus());
    link.on('unauthorized', () => {
      log.warn('köprü yetkisi kaldırıldı — eşleştirme siliniyor');
      this.config.clearBridge();
      this.bridge = null;
      this.emitStatus();
    });

    this.bridge = link;
    await link.start();
    this.emitStatus();
  }

  /** Kurulum kodunu köprü kimliğiyle takas eder ve bağlanır. */
  async pairBridgeWithCode(code: string): Promise<BridgePairing> {
    const cfg = this.config.get();
    const paired = await pairBridge(cfg.apiBaseUrl, code);
    const { deviceKey, ...pairing } = paired;

    // Anahtar ÖNCE güvenli depoya, sonra yapılandırmaya: sıra tersine olsaydı
    // araya giren bir çökme, kimliği olan ama anahtarı olmayan bir ajan
    // bırakırdı ve o hâl elle kurtarılamaz.
    this.config.setBridgeKey(deviceKey);
    this.config.update({ bridge: pairing });
    log.info('köprü eşleştirildi', { terminal: pairing.terminalLabel });

    await this.connectBridge();
    return pairing;
  }

  unpairBridge(): void {
    this.bridge?.stop();
    this.bridge = null;
    this.config.clearBridge();
    this.emitStatus();
  }

  setOkc(okc: OkcConfig | undefined): void {
    this.config.update({ okc });
    this.okc.setConfig(okc);
    this.emitStatus();
  }

  /** Kasiyerin elle tetiklediği kurtarma — yarım kalan belgeyi tekrar dener. */
  async retryPendingSale(): Promise<OkcSaleResult | null> {
    const result = await this.okc.retryPending();
    if (!result) return null;
    this.recordSale(result);
    // Sonuç BACKEND'E DE gider. `lookup` yalnızca sorulursa cevap veriyor ve
    // süpürge o soruyu bir kez soruyor; kurtarma o andan sonra başarılı olursa
    // kesilmiş bir fiş adisyona hiç işlenmezdi. `UNKNOWN` burada da
    // gönderilmiyor — onu `BridgeLink` eliyor.
    this.bridge?.reportResult(result);
    return result;
  }

  setAutostartEnabled(enabled: boolean): void {
    this.config.update({ autostart: enabled });
    setAutostart(enabled);
    this.emitStatus();
  }

  setDeviceName(name: string): void {
    this.config.update({ deviceName: name.trim() || this.config.get().deviceName });
    this.emitStatus();
  }

  testPrint(station: Station): Promise<void> {
    const heading = { BAR: 'BAR', KITCHEN: 'MUTFAK', CASHIER: 'KASA' }[station];
    return this.engine.testPrint(this.config.get().printers[station], heading);
  }

  /** The test slip names the panel record, so it can be matched to the machine. */
  testPairingPrint(deviceId: string): Promise<void> {
    const pairing = this.config.get().pairings.find((p) => p.deviceId === deviceId);
    if (!pairing) throw new Error('Yazıcı bulunamadı');
    return this.engine.testPrint(pairing.local, pairing.printerName.toLocaleUpperCase('tr-TR'));
  }

  async refreshPrinterHealth(): Promise<void> {
    const cfg = this.config.get();
    const health: StatusSnapshot['printerHealth'] = {};
    for (const station of STATIONS) {
      if (!cfg.printers[station]) continue;
      const result = await this.engine.probe(cfg.printers[station]);
      health[station] = { ok: result.ok, checkedAt: new Date().toISOString(), error: result.error };
    }
    this.printerHealth = health;

    this.pairingHealth.clear();
    for (const pairing of cfg.pairings) {
      if (!pairing.local) continue;
      const result = await this.engine.probe(pairing.local);
      this.pairingHealth.set(pairing.deviceId, {
        ok: result.ok,
        checkedAt: new Date().toISOString(),
        ...(result.error ? { error: result.error } : {}),
      });
    }
    this.emitStatus();
  }

  status(): StatusSnapshot {
    const cfg = this.config.get();
    const env = envConfig();
    const first = cfg.pairings[0];
    return {
      pairings: cfg.pairings.map((p) => ({
        ...p,
        connection: this.connectionStates.get(p.deviceId) ?? 'CONNECTING',
        ...(this.pairingHealth.has(p.deviceId) ? { health: this.pairingHealth.get(p.deviceId) } : {}),
      })),
      connection: this.aggregateState(),
      paired: this.config.isPaired(),
      tenantName: first?.tenantName,
      branchName: first?.branchName,
      deviceName: cfg.deviceName,
      appVersion: this.appVersion,
      env: env.env,
      apiBaseUrl: env.apiBaseUrl,
      logLevel: env.logLevel,
      autostart: cfg.autostart,
      queued: this.queue.size(),
      lastJob: this.lastJob,
      printers: cfg.printers,
      printerHealth: this.printerHealth,
      okc: cfg.okc,
      okcHealth: this.okc.getHealth(),
      lastSale: this.lastSale,
      bridge: cfg.bridge,
      bridgeConnected: this.bridge?.isConnected() ?? false,
    };
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }

  /** Dev/QA helper: inject a job as if the gateway had dispatched it. */
  injectJob(job: PrintJob): boolean {
    return this.queue.enqueue(job);
  }

  autostartActive(): boolean {
    return isAutostartEnabled();
  }
}
