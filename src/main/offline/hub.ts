import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

import type { PrintJob, Station, TicketModel } from '../../shared/types';
import { log } from '../logger';
import { grantSecret, verifyOpMac } from './crypto';
import {
  acceptSnapshot,
  acknowledge,
  applyOp,
  billTicket,
  clientView,
  emptyHubData,
  type ApplyResult,
  type HubData,
  type HubMode,
  type TicketRequest,
} from './hub-state';
import { HubServer, type HubRoute } from './hub-server';
import { HubStore, type HubCipher } from './hub-store';
import {
  OFFLINE_HUB_PORT,
  OFFLINE_PROTOCOL_VERSION,
  OFFLINE_SYNC_BATCH_MAX,
  type OfflineGrantClaims,
  type OfflineHubPing,
  type OfflineSnapshot,
  type OfflineSyncResult,
  type SignedOfflineOp,
} from './protocol';

/**
 * YEREL MERKEZ — kasa bilgisayarındaki ajanın internet kesintisindeki rolü.
 * Tasarım: ari-adisyon-backend/docs/CEVRIMDISI-CALISMA.md.
 *
 * İnternet varken: 5 dakikada bir (ve bulut "tazele" dürttüğünde) şubenin
 * anlık görüntüsünü alır, ağ ucu açık durur ve `ping`e "online" der —
 * istemciler buluta gider. Buluta 10 saniye ulaşılamazsa "offline" olur:
 * istemciler buraya yazar, fişleri bu basar. Bulut geri gelince "draining":
 * günlük sırayla aktarılır, sonra "online".
 *
 * Merkez olup olmadığına bulut karar verir (Yönetim → Donanım → İnternet
 * kesilince): bu bilgisayarın eşleşmelerinden biri seçiliyse merkezdir.
 * Seçim kalkınca yerel veri silinir.
 */

export interface HubPairing {
  deviceId: string;
  stations: Station[];
  /** Bu bilgisayarda bir yazıcıya bağlı mı (fiş basılabilir mi). */
  printable: boolean;
}

export interface HubDeps {
  apiBaseUrl: () => string;
  pairings: () => HubPairing[];
  token: (deviceId: string) => string | null;
  enqueue: (job: PrintJob) => void;
  posOrigin: () => Promise<string | null>;
  dataDir: string;
  cipher: HubCipher;
  /** Testte `127.0.0.1` ve 0 (rastgele port). */
  host?: string;
  port?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Testte kısaltılır. */
  timings?: Partial<typeof TIMINGS>;
}

export interface HubStatus {
  role: 'hub' | 'none';
  mode: HubMode;
  pending: number;
  rejected: number;
  snapshotAt: string | null;
  listening: boolean;
  addresses: string[];
  unprintable: number;
}

const TIMINGS = {
  refreshMs: 5 * 60_000,
  offlineAfterMs: 10_000,
  probeWhileOfflineMs: 20_000,
  nudgeDebounceMs: 1_500,
  busyRetryMs: 5_000,
  errorRetryMs: 10_000,
  pollMaxMs: 25_000,
};

const API_PREFIX = '/api/v1';
const MAX_OPS_PER_REQUEST = 20;
const MAX_WAITERS = 40;

export class OfflineHub extends EventEmitter {
  private data: HubData | null;
  private readonly store: HubStore;
  private readonly server: HubServer;
  private readonly timings: typeof TIMINGS;
  private refreshTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private offlineTimer: NodeJS.Timeout | null = null;
  private cloudDownSince: number | null = null;
  private refreshing: Promise<void> | null = null;
  private draining = false;
  private stopped = true;
  private unprintable = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly deps: HubDeps) {
    super();
    this.timings = { ...TIMINGS, ...deps.timings };
    this.store = new HubStore(deps.dataDir, deps.cipher);
    this.data = this.store.load();
    this.server = new HubServer({
      port: deps.port ?? OFFLINE_HUB_PORT,
      host: deps.host ?? '0.0.0.0',
      ping: () => this.ping(),
      key: () => (this.data ? { key: Buffer.from(this.data.hubKey, 'base64url'), branchId: this.data.branchId } : null),
      posOrigin: deps.posOrigin,
      handle: (route, claims, body, signal) => this.handle(route, claims, body, signal),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.server.start();
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), this.timings.refreshMs);
    this.refreshTimer.unref?.();
    // Ajan kesinti ortasında yeniden başladıysa kaldığı yerden devam: bekleyen
    // işlem varsa önce buluta ulaşılıp ulaşılamadığı anlaşılsın.
    if (this.data && this.data.log.length > 0 && this.data.mode === 'online') this.data.mode = 'offline';
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of [this.refreshTimer, this.probeTimer, this.nudgeTimer, this.offlineTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.refreshTimer = this.probeTimer = this.nudgeTimer = this.offlineTimer = null;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    this.store.flush();
    await this.server.stop();
  }

  /** Bulut "şubede bir şey değişti" dedi. */
  nudge(): void {
    if (this.nudgeTimer || this.stopped) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.refresh();
    }, this.timings.nudgeDebounceMs);
    this.nudgeTimer.unref?.();
  }

  /** Ajanın bulut soketinin durumu — kesintinin en hızlı işareti. */
  setCloudConnected(connected: boolean): void {
    if (connected) this.cloudOk();
    else this.cloudFail();
  }

  status(): HubStatus {
    return {
      role: this.data ? 'hub' : 'none',
      mode: this.data?.mode ?? 'online',
      pending: this.data?.log.length ?? 0,
      rejected: this.data?.rejected.length ?? 0,
      snapshotAt: this.data?.snapshotAt ?? null,
      listening: this.server.listening,
      addresses: localAddresses(),
      unprintable: this.unprintable,
    };
  }

  /** Test ve teşhis için: dinlenen port. */
  port(): number | null {
    return this.server.address();
  }

  // ── Bulut ─────────────────────────────────────────────────────────────────

  private ping(): OfflineHubPing | null {
    if (!this.data) return null;
    return {
      hub: true,
      v: OFFLINE_PROTOCOL_VERSION,
      branchId: this.data.branchId,
      mode: this.data.mode,
      pending: this.data.log.length,
      snapshotAt: this.data.snapshotAt,
    };
  }

  /** Anlık görüntüyü al (ya da değişmediğini öğren). Aynı anda tek çağrı. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const pairings = this.deps.pairings();
    if (pairings.length === 0) return this.resign('eşleşme yok');
    // Önce bilinen merkez eşleşmesi, sonra diğerleri (ilk kurulum, merkez değişimi).
    const ordered = this.data
      ? [...pairings.filter((p) => p.deviceId === this.data?.hubDeviceId), ...pairings.filter((p) => p.deviceId !== this.data?.hubDeviceId)]
      : pairings;
    let anyAnswer = false;
    for (const pairing of ordered) {
      const token = this.deps.token(pairing.deviceId);
      if (!token) continue;
      const result = await this.call<{
        hub: boolean;
        notModified?: boolean;
        snapshot?: OfflineSnapshot;
        snapshotId?: string;
        hubKey?: string;
        keyVersion?: number;
      }>(token, '/agent/offline/snapshot', {
        addresses: localAddresses(),
        port: this.server.address() ?? OFFLINE_HUB_PORT,
        ifNoneMatch: this.data?.hubDeviceId === pairing.deviceId && this.data.log.length === 0 ? this.data.snapshot?.snapshotId : undefined,
      });
      if (result.kind === 'network') {
        this.cloudFail();
        return;
      }
      anyAnswer = true;
      this.cloudOk();
      if (result.kind !== 'ok' || !result.body.hub || !result.body.hubKey || result.body.keyVersion === undefined) continue;

      const body = result.body;
      const snapshot = body.snapshot;
      const branchId = snapshot?.branch.id ?? this.data?.branchId;
      if (!branchId) continue;
      if (!this.data || this.data.branchId !== branchId || this.data.hubDeviceId !== pairing.deviceId) {
        if (this.data && this.data.log.length > 0) log.warn('offline hub changed with pending ops', { pending: this.data.log.length });
        this.data = emptyHubData({ branchId, hubKey: body.hubKey!, keyVersion: body.keyVersion!, hubDeviceId: pairing.deviceId });
      }
      this.data.hubKey = body.hubKey!;
      this.data.keyVersion = body.keyVersion!;
      if (snapshot) acceptSnapshot(this.data, snapshot, new Date(this.now()));
      else this.data.snapshotAt = new Date(this.now()).toISOString();
      this.persist();
      return;
    }
    if (anyAnswer) await this.resign('bulut bu bilgisayarı merkez olarak seçmemiş');
  }

  /** Merkez değiliz (ya da artık değiliz): yerel veri gider (KVKK). */
  private async resign(reason: string): Promise<void> {
    if (!this.data) return;
    log.info('offline hub role dropped', { reason, pending: this.data.log.length });
    this.data = null;
    this.store.wipe();
    this.wake();
    this.emit('changed');
  }

  private cloudOk(): void {
    this.cloudDownSince = null;
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    if (!this.data) return;
    if (this.data.mode === 'offline' || (this.data.mode === 'online' && this.data.log.length > 0)) {
      this.setMode(this.data.log.length > 0 ? 'draining' : 'online');
    }
    if (this.data.mode === 'draining') void this.drain();
  }

  private cloudFail(): void {
    if (this.cloudDownSince === null) this.cloudDownSince = this.now();
    if (!this.data || this.data.mode === 'offline' || this.offlineTimer) return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (this.cloudDownSince === null || !this.data) return;
      this.setMode('offline');
      // Kesintide bulutu ara ara yokla: geri gelince aktarım başlasın.
      if (!this.probeTimer) {
        this.probeTimer = setInterval(() => void this.refresh(), this.timings.probeWhileOfflineMs);
        this.probeTimer.unref?.();
      }
    }, this.timings.offlineAfterMs);
    this.offlineTimer.unref?.();
  }

  private setMode(mode: HubMode): void {
    if (!this.data || this.data.mode === mode) return;
    log.info('offline hub mode', { from: this.data.mode, to: mode, pending: this.data.log.length });
    this.data.mode = mode;
    this.data.seq += 1;
    this.persist();
  }

  /** Günlüğü sırayla aktar; yeni işlem gelirse kuyruğun sonuna eklenir. */
  private async drain(): Promise<void> {
    if (this.draining || !this.data) return;
    this.draining = true;
    try {
      while (this.data && this.data.log.length > 0 && !this.stopped) {
        const data = this.data;
        const token = this.deps.token(data.hubDeviceId);
        if (!token) return;
        const batch = data.log.slice(0, OFFLINE_SYNC_BATCH_MAX);
        const final = data.log.length <= OFFLINE_SYNC_BATCH_MAX;
        this.store.flush();
        const result = await this.call<{ results: OfflineSyncResult[] }>(token, '/agent/offline/sync', { ops: batch, final });
        if (result.kind === 'network') {
          this.cloudFail();
          return;
        }
        if (result.kind === 'busy') {
          await delay(this.timings.busyRetryMs);
          continue;
        }
        if (result.kind !== 'ok') {
          log.warn('offline sync refused', { status: result.status });
          await delay(this.timings.errorRetryMs);
          if (result.status === 403) return void (await this.refresh());
          continue;
        }
        const outcome = acknowledge(data, result.body.results, new Date(this.now()));
        log.info('offline sync batch', { sent: batch.length, ...outcome, left: data.log.length });
        data.seq += 1;
        this.persist({ durable: true });
      }
      if (this.data && this.data.log.length === 0) {
        this.setMode('online');
        // Bulut artık doğru: adisyonları oradan tazele.
        await this.refresh();
      }
    } finally {
      this.draining = false;
    }
  }

  private async call<T>(
    token: string,
    path: string,
    body: unknown,
  ): Promise<{ kind: 'ok'; body: T } | { kind: 'busy' } | { kind: 'network' } | { kind: 'error'; status: number }> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`${this.deps.apiBaseUrl().replace(/\/$/, '')}${API_PREFIX}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status >= 500) return { kind: 'network' };
      if (res.status === 409) return { kind: 'busy' };
      if (!res.ok) return { kind: 'error', status: res.status };
      const json = (await res.json()) as { data?: T } & T;
      return { kind: 'ok', body: (json.data ?? json) as T };
    } catch {
      return { kind: 'network' };
    }
  }

  // ── İstemciler ────────────────────────────────────────────────────────────

  private async handle(route: HubRoute, claims: OfflineGrantClaims, body: unknown, signal: AbortSignal): Promise<unknown> {
    const data = this.data;
    if (!data) return { error: 'not-hub' };
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    switch (route) {
      case '/v1/state':
        return clientView(data, typeof input.known === 'string' ? input.known : null);
      case '/v1/poll':
        return this.poll(typeof input.since === 'number' ? input.since : -1, signal);
      case '/v1/bill': {
        if (typeof input.orderRef !== 'string') return { error: 'invalid' };
        const ticket = billTicket(data, input.orderRef, claims.name, new Date(this.now()));
        if (!ticket) return { error: 'not-found' };
        this.print(ticket);
        return { ok: true };
      }
      case '/v1/ops':
        return this.acceptOps(claims, input.ops);
    }
  }

  private acceptOps(claims: OfflineGrantClaims, raw: unknown): { results: (ApplyResult & { opId: string })[]; seq: number } {
    const data = this.data;
    if (!data) return { results: [], seq: -1 };
    const ops = Array.isArray(raw) ? raw.slice(0, MAX_OPS_PER_REQUEST) : [];
    const key = Buffer.from(data.hubKey, 'base64url');
    const secret = grantSecret(key, claims.gid);
    const now = new Date(this.now());
    const results: (ApplyResult & { opId: string })[] = [];
    for (const entry of ops) {
      const signed = entry as SignedOfflineOp;
      const opId = typeof signed?.op?.opId === 'string' ? signed.op.opId : 'unknown';
      // İşlem, zarfı açan izinle imzalanmış olmalı — başka birinin iznini
      // taşıyan işlem kabul edilmez.
      if (!signed || signed.grant === undefined || !verifyOpMac(secret, signed.op, signed.mac)) {
        results.push({ opId, status: 'rejected', code: 'MAC_INVALID', message: 'İşlem imzası geçersiz', prints: [] });
        continue;
      }
      const result = applyOp(data, { op: signed.op, grant: signed.grant, mac: signed.mac, seq: 0 }, claims, now);
      for (const ticket of result.prints) this.print(ticket);
      results.push({ ...result, opId, prints: [] });
    }
    if (results.some((row) => row.status === 'applied')) {
      // Cevaptan ÖNCE diske: garsona "tamam" dediğimiz ve fişi basılan işlem,
      // hemen ardından elektrik gitse de kaybolmamalı.
      this.persist({ durable: true });
      // İnternet varken bir istemci merkeze yazdıysa (kendi bağlantısı kopmuş
      // olabilir) bekletmeden aktar.
      if (data.mode === 'online') this.setMode('draining');
      if (data.mode === 'draining') void this.drain();
    }
    return { results, seq: data.seq };
  }

  private poll(since: number, signal: AbortSignal): Promise<{ seq: number; mode: HubMode; pending: number }> {
    const answer = () => ({ seq: this.data?.seq ?? -1, mode: this.data?.mode ?? 'online', pending: this.data?.log.length ?? 0 });
    if (!this.data || this.data.seq !== since || this.waiters.size >= MAX_WAITERS) return Promise.resolve(answer());
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(answer());
      };
      const timer = setTimeout(done, this.timings.pollMaxMs);
      timer.unref?.();
      signal.addEventListener('abort', done, { once: true });
      this.waiters.add(done);
    });
  }

  private wake(): void {
    for (const done of [...this.waiters]) done();
  }

  private persist(options: { durable?: boolean } = {}): void {
    if (this.data) {
      this.store.save(this.data);
      if (options.durable) this.store.flush();
    }
    this.wake();
    this.emit('changed');
  }

  // ── Fiş ───────────────────────────────────────────────────────────────────

  /**
   * Sunucuyla aynı yönlendirme (`printing.service.ts` → `printersFor`):
   * yazıcının hazırlık istasyonları bu istasyonu içeriyorsa, ya da liste boş
   * ve istasyon türü uyuyorsa. Yalnızca BU bilgisayardaki eşleşmelere basılır.
   */
  private print(ticket: TicketRequest): void {
    const snapshot = this.data?.snapshot;
    const local = this.deps.pairings().filter((pairing) => pairing.printable);
    const localIds = new Set(local.map((pairing) => pairing.deviceId));
    const prepId =
      ticket.prepStationId ?? snapshot?.prepStations.find((row) => row.station === ticket.station)?.id ?? null;
    let targets = (snapshot?.printers ?? []).filter(
      (printer) =>
        localIds.has(printer.deviceId) &&
        ((prepId !== null && printer.prepStationIds.includes(prepId)) ||
          (printer.prepStationIds.length === 0 && printer.stations.includes(ticket.station))),
    );
    if (ticket.kind === 'BILL') {
      targets = (snapshot?.printers ?? []).filter((printer) => localIds.has(printer.deviceId) && printer.stations.includes('CASHIER'));
    }
    let routes = targets.map((printer) => printer.deviceId);
    if (routes.length === 0) {
      // Son çare: istasyonu taşıyan herhangi bir yerel eşleşme.
      routes = local.filter((pairing) => pairing.stations.includes(ticket.station)).map((pairing) => pairing.deviceId).slice(0, 1);
    }
    if (routes.length === 0) {
      this.unprintable += 1;
      log.warn('offline ticket has no local printer', { station: ticket.station, kind: ticket.kind });
      this.emit('changed');
      return;
    }
    const content: TicketModel = {
      kind: ticket.kind,
      station: ticket.station,
      orderNo: ticket.orderLabel,
      ...(ticket.tableName ? { tableName: ticket.tableName } : {}),
      ...(ticket.waiterName ? { waiterName: ticket.waiterName } : {}),
      createdAt: ticket.at,
      items: ticket.items,
      ...(ticket.totals ? { totals: ticket.totals } : {}),
      footer: 'ÇEVRİMDIŞI — internet gelince aktarılır',
    };
    for (const route of routes) {
      this.deps.enqueue({ jobId: `offline:${randomUUID()}`, station: ticket.station, copies: 1, content, route });
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/** Bu bilgisayarın özel IPv4 adresleri — garson telefonları buraya bağlanır. */
export function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const [a, b] = entry.address.split('.').map(Number) as [number, number];
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) out.push(entry.address);
    }
  }
  return out.slice(0, 4);
}
