import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { ClientMessage, ConnectionState, DeviceInfo, JobAck, PrintJob, ServerMessage } from '../shared/types';
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
        else log.warn('malformed job payload');
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

function isPrintJob(value: unknown): value is PrintJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as PrintJob;
  return (
    typeof job.jobId === 'string' &&
    (job.station === 'BAR' || job.station === 'KITCHEN') &&
    (typeof job.escpos === 'string' || typeof job.content === 'object')
  );
}
