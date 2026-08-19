import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { isStation } from '../shared/types';
import type {
  ClientMessage,
  ConnectionState,
  DeviceInfo,
  JobAck,
  PrintJob,
  ServerMessage,
} from '../shared/types';
import { atomicWrite } from './fsutil';
import { log } from './logger';

const HEARTBEAT_MS = 25_000;
const PONG_GRACE_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

export interface ConnectionOptions {
  wsUrl: string;
  token: string;
  deviceInfo: DeviceInfo;
  dataDir: string;
  queuedCount: () => number;
}

/**
 * Outbound-only WSS to the gateway. Nothing listens on the café PC — no inbound
 * ports, nothing to port-forward.
 */
export class ConnectionManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'OFFLINE';
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly outboxPath: string;
  private outbox: JobAck[];

  constructor(private readonly opts: ConnectionOptions) {
    super();
    this.outboxPath = path.join(opts.dataDir, 'ack-outbox.json');
    this.outbox = this.loadOutbox();
  }

  getState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private open(): void {
    if (this.closed) return;
    this.setState(this.attempt === 0 ? 'CONNECTING' : 'OFFLINE');

    const ws = new WebSocket(this.opts.wsUrl, {
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        'User-Agent': `AriAdisyonAgent/${this.opts.deviceInfo.appVersion}`,
      },
      handshakeTimeout: 10_000,
      // `ws` allows 100 MB frames by default. A ticket is kilobytes; anything
      // larger is a bug or an attempt to exhaust the till's memory before a
      // single line of our own validation runs.
      maxPayload: 2 * 1024 * 1024,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.setState('CONNECTED');
      log.info('ws connected');
      this.send({ type: 'hello', payload: { ...this.opts.deviceInfo, queued: this.opts.queuedCount() } });
      this.flushOutbox();
      this.startHeartbeat();
      this.emit('connected');
    });

    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('pong', () => this.clearPongTimer());

    ws.on('unexpected-response', (_req, res) => {
      log.warn('ws rejected', { status: res.statusCode });
      // 401/403 means the token was revoked or is invalid — stop hammering the server.
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.closed = true;
        this.setState('UNPAIRED');
        this.emit('unauthorized');
      }
    });

    ws.on('error', (err) => log.warn('ws error', { message: err.message }));

    ws.on('close', (code) => {
      this.stopHeartbeat();
      this.ws = null;
      if (this.closed) {
        this.setState(this.state === 'UNPAIRED' ? 'UNPAIRED' : 'OFFLINE');
        return;
      }
      log.info('ws closed', { code });
      this.setState('OFFLINE');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.attempt += 1;
    // Exponential backoff with jitter so a gateway restart doesn't get a thundering herd.
    const base = Math.min(1000 * 2 ** Math.min(this.attempt, 5), MAX_BACKOFF_MS);
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      this.clearPongTimer();
      // No pong in time → the socket is a zombie (NAT drop, sleeping AP). Kill it.
      this.pongTimer = setTimeout(() => {
        log.warn('heartbeat timeout — terminating socket');
        this.ws?.terminate();
      }, PONG_GRACE_MS);
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private onMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      log.warn('unparseable ws message');
      return;
    }
    switch (msg.type) {
      case 'job':
        if (isPrintJob(msg.payload)) this.emit('job', msg.payload);
        else this.rejectJob(msg.payload);
        break;
      case 'revoked':
        log.warn('device revoked by panel', { reason: msg.reason });
        this.closed = true;
        this.setState('UNPAIRED');
        this.ws?.close();
        this.emit('unauthorized');
        break;
      case 'pong':
        break;
    }
  }

  /**
   * Refuse a job OUT LOUD.
   *
   * Dropping it silently is what made a dead cashier receipt look like a live
   * one: the backend hands a job over, waits for an ack that never comes,
   * reclaims it as stale, and hands it over again — forever. The panel counts
   * that row as "1 kuyrukta" the whole time, so an operator watches a queue
   * that will never move and has no way to learn why.
   *
   * A failed ack ends it: the row goes FAILED with a reason attached, the
   * redelivery loop stops, and the number on the panel becomes true again. We
   * say WHY, because "the agent refused it" is the one fact nobody else has.
   *
   * Without a usable jobId there is nothing to ack against, so that case stays
   * a log line — it is also the only case the backend cannot mis-count, since a
   * job it never created cannot sit in anyone's queue.
   */
  private rejectJob(payload: unknown): void {
    const details = describeRejectedJob(payload);
    log.warn('malformed job payload', details);

    const { jobId, reason } = details;
    if (typeof jobId !== 'string' || jobId.length === 0) return;
    this.ack({
      jobId,
      status: 'failed',
      attempts: 0,
      error: `Ajan işi kabul etmedi (${String(reason)}) — sürüm ${this.opts.deviceInfo.appVersion}`,
    });
  }

  // --- acks ---------------------------------------------------------------

  /** Acks survive restarts: a printed ticket is never re-sent by the backend. */
  ack(ack: JobAck): void {
    this.outbox.push(ack);
    this.persistOutbox();
    this.flushOutbox();
  }

  private flushOutbox(): void {
    if (this.ws?.readyState !== WebSocket.OPEN || this.outbox.length === 0) return;
    const pending = [...this.outbox];
    this.outbox = [];
    for (const payload of pending) {
      if (!this.send({ type: 'job.ack', payload })) this.outbox.push(payload);
    }
    this.persistOutbox();
  }

  private send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      log.warn('ws send failed', err);
      return false;
    }
  }

  private loadOutbox(): JobAck[] {
    try {
      return JSON.parse(fs.readFileSync(this.outboxPath, 'utf8')) as JobAck[];
    } catch {
      return [];
    }
  }

  private persistOutbox(): void {
    atomicWrite(this.outboxPath, JSON.stringify(this.outbox));
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.setState('OFFLINE');
  }
}

/**
 * Everything below is a size or shape limit on data the gateway sends us.
 *
 * The gateway is trusted, but "trusted" is not "incapable of a bug", and the
 * agent runs on a café's till with a durable on-disk queue. An oversized or
 * malformed job is not a hypothetical: one bad payload is written to
 * `queue.json`, reloaded on every restart, and retried twenty times. Rejecting
 * it at the door costs one log line; accepting it can fill a disk and take the
 * till's printing down until someone deletes a file by hand.
 */
const MAX_JOB_ID = 128;
/** ~1 MB of base64 ≈ 750 KB of ESC/POS — a very long ticket is a few KB. */
const MAX_ESCPOS_B64 = 1_000_000;
const MAX_ITEMS = 200;
const MAX_TEXT = 500;

function isSaneText(value: unknown, max = MAX_TEXT): boolean {
  return typeof value === 'string' && value.length <= max;
}

function isTicketModel(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  if (!Array.isArray(t.items) || t.items.length > MAX_ITEMS) return false;
  if (!isSaneText(t.orderNo, 64)) return false;
  return t.items.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const i = item as Record<string, unknown>;
    const options = i.options;
    return (
      typeof i.qty === 'number' &&
      Number.isFinite(i.qty) &&
      isSaneText(i.name) &&
      (i.note === undefined || isSaneText(i.note)) &&
      (options === undefined ||
        (Array.isArray(options) && options.length <= 50 && options.every((o) => isSaneText(o))))
    );
  });
}

export function isPrintJob(value: unknown): value is PrintJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as PrintJob;

  // The jobId is the idempotency key and is kept for 24h in `done` — an
  // unbounded one is a slow way to grow a file that is read on every start.
  if (typeof job.jobId !== 'string' || job.jobId.length === 0 || job.jobId.length > MAX_JOB_ID) {
    return false;
  }
  if (!isStation(job.station)) return false;
  if (job.copies !== undefined && (typeof job.copies !== 'number' || !Number.isFinite(job.copies))) {
    return false;
  }
  if (job.codepage !== undefined && !isSaneText(job.codepage, 32)) return false;

  if (typeof job.escpos === 'string') return job.escpos.length <= MAX_ESCPOS_B64;
  return isTicketModel(job.content);
}

/**
 * Identifying fields of a job we refused, for the log line only.
 *
 * Deliberately just the identifiers and the reason: the ticket body is a
 * customer's order and does not belong in a file support asks people to copy
 * out. `station` is echoed back even when it is the thing that was wrong —
 * that is precisely the case worth reading.
 */
function describeRejectedJob(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return { reason: 'not an object' };
  const job = value as Partial<PrintJob>;
  const reason =
    typeof job.jobId !== 'string' || job.jobId.length === 0 || job.jobId.length > MAX_JOB_ID
      ? 'jobId'
      : !isStation(job.station)
        ? 'station'
        : job.escpos === undefined && job.content === undefined
          ? 'no printable body'
          : 'body';
  return {
    jobId: typeof job.jobId === 'string' ? job.jobId.slice(0, MAX_JOB_ID) : null,
    station: typeof job.station === 'string' ? job.station.slice(0, 32) : null,
    reason,
  };
}

