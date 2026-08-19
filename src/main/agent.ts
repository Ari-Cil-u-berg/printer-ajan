import { EventEmitter } from 'node:events';
import { STATIONS } from '../shared/types';
import type {
  AgentConfig,
  ConnectionState,
  BridgePairing,
  OkcConfig,
  OkcSaleResult,
  PrinterConfig,
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
  private connection: ConnectionManager | null = null;
  private connectionState: ConnectionState = 'UNPAIRED';
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
    this.engine = new PrintEngine((station) => this.config.get().printers[station]);
    this.queue = new JobQueue(this.config.dataDir(), (job) => this.engine.print(job));
    this.okc = new OkcManager(this.config.dataDir(), this.config.get().okc, (okc) =>
      this.config.update({ okc }),
    );
    this.okc.on('changed', () => this.emitStatus());

    this.queue.on('ack', (ack) => {
      this.lastJob = {
        jobId: ack.jobId,
        station: this.lastJob?.station ?? 'BAR',
        status: ack.status === 'printed' ? 'Yazdırıldı' : 'Başarısız',
        at: new Date().toISOString(),
        error: ack.error,
      };
      this.connection?.ack(ack);
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
    this.connectIfPaired();
    void this.connectBridge();
    this.probeTimer = setInterval(() => void this.refreshPrinterHealth(), PROBE_INTERVAL_MS);
    void this.refreshPrinterHealth();
  }

  stop(): void {
    this.queue.stop();
    this.okc.stop();
    this.bridge?.stop();
    this.connection?.close();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.probeTimer) clearInterval(this.probeTimer);
  }

  private connectIfPaired(): void {
    const token = this.config.getToken();
    if (!token) {
      this.setConnectionState('UNPAIRED');
      return;
    }
    const cfg = this.config.get();
    this.connection?.close();
    const conn = new ConnectionManager({
      wsUrl: cfg.wsUrl,
      token,
      deviceInfo: deviceInfo(this.appVersion, cfg.deviceName),
      dataDir: this.config.dataDir(),
      queuedCount: () => this.queue.size(),
    });
    conn.on('state', (state: ConnectionState) => this.setConnectionState(state));
    conn.on('job', (job: PrintJob) => {
      log.info('job received', { jobId: job.jobId, station: job.station });
      this.lastJob = { jobId: job.jobId, station: job.station, status: 'Kuyrukta', at: new Date().toISOString() };
      this.queue.enqueue(job);
    });
    conn.on('connected', () => this.queue.pumpAll());
    conn.on('unauthorized', () => {
      // Revoked from the panel or a wiped token: drop credentials, ask for re-pairing.
      log.warn('token rejected — clearing pairing');
      this.config.clearToken();
      this.setConnectionState('UNPAIRED');
      this.emit('unauthorized');
    });
    this.connection = conn;
    conn.connect();

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const t = this.config.getToken();
      if (t) void heartbeat(cfg.apiBaseUrl, t, this.appVersion);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.emitStatus();
  }

  // --- actions used by IPC ------------------------------------------------

  async pairWithCode(code: string): Promise<void> {
    const cfg = this.config.get();
    const result = await pair(cfg.apiBaseUrl, code, deviceInfo(this.appVersion, cfg.deviceName));
    this.config.setToken(result.deviceToken);
    this.config.update({
      pairing: {
        deviceId: result.deviceId,
        tenantId: result.tenantId,
        branchId: result.branchId,
        tenantName: result.tenantName,
        branchName: result.branchName,
      },
    });
    log.info('paired', { tenant: result.tenantName, branch: result.branchName });
    this.connectIfPaired();
  }

  unpair(): void {
    this.connection?.close();
    this.connection = null;
    this.config.clearToken();
    this.setConnectionState('UNPAIRED');
  }

  setPrinter(station: Station, printer: PrinterConfig | undefined): AgentConfig {
    const printers = { ...this.config.get().printers };
    if (printer) printers[station] = printer;
    else delete printers[station];
    const cfg = this.config.update({ printers });
    void this.refreshPrinterHealth();
    this.queue.pumpAll(); // a fixed printer should drain the backlog immediately
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
    if (result) this.recordSale(result);
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
    return this.engine.testPrint(station);
  }

  async refreshPrinterHealth(): Promise<void> {
    const health: StatusSnapshot['printerHealth'] = {};
    for (const station of STATIONS) {
      if (!this.config.get().printers[station]) continue;
      const result = await this.engine.probe(station);
      health[station] = { ok: result.ok, checkedAt: new Date().toISOString(), error: result.error };
    }
    this.printerHealth = health;
    this.emitStatus();
  }

  status(): StatusSnapshot {
    const cfg = this.config.get();
    const env = envConfig();
    return {
      connection: this.connectionState,
      paired: this.config.isPaired(),
      tenantName: cfg.pairing?.tenantName,
      branchName: cfg.pairing?.branchName,
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
