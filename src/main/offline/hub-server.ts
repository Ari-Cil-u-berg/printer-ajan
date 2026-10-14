import http from 'node:http';

import { log } from '../logger';
import { grantSecret, isEnvelope, openEnvelope, sealEnvelope, verifyGrant } from './crypto';
import {
  OFFLINE_CLOCK_SKEW_MS,
  OFFLINE_ENVELOPE_MAX_BYTES,
  OFFLINE_PROTOCOL_VERSION,
  type OfflineGrantClaims,
  type OfflineHubPing,
} from './protocol';

/**
 * YEREL MERKEZİN AĞ UCU — `0.0.0.0:47821`.
 *
 * Kim konuşur: kasa (aynı bilgisayardaki Chrome, `127.0.0.1` üzerinden) ve
 * garson uygulaması (aynı Wi-Fi, özel IP üzerinden). İnternet varken de açık
 * durur; `/v1/ping` istemcilere "buluta git" der.
 *
 * GÜVENLİK, katman katman (docs/CEVRIMDISI-CALISMA.md §5):
 *   - `Host` yalnızca özel IP / localhost — bir alan adını yerel IP'ye çözüp
 *     tarayıcıyı buraya yönlendiren DNS rebinding saldırısı düşer.
 *   - `Origin` varsa POS kökeniyle BİREBİR aynı olmalı; CORS yalnızca ona.
 *     Mobil uygulama (yerel istemci) Origin göndermez.
 *   - IP başına hız sınırı, 256 KB gövde sınırı.
 *   - Her istek şifreli zarf: izin merkez anahtarıyla imzalı mı, bu şubenin
 *     mi, süresi geçmemiş mi; zaman ±5 dk; nonce tek kullanımlık; gövde
 *     AES-256-GCM (adres ve zaman AAD'de). Cevap da şifreli.
 *   - Hata cevabı ayrıntı vermez (yalnızca makine kodu).
 */

export const HUB_ROUTES = ['/v1/state', '/v1/ops', '/v1/poll', '/v1/bill'] as const;
export type HubRoute = (typeof HUB_ROUTES)[number];

export interface HubServerDeps {
  port: number;
  /** `0.0.0.0` (üretim) ya da `127.0.0.1` (test). */
  host: string;
  ping(): OfflineHubPing | null;
  /** Merkez anahtarı ve şube — merkez değilse `null` (her istek 503). */
  key(): { key: Buffer; branchId: string } | null;
  posOrigin(): Promise<string | null>;
  handle(route: HubRoute, claims: OfflineGrantClaims, body: unknown, signal: AbortSignal): Promise<unknown>;
  now?: () => number;
}

const RATE_LIMIT = 300;
const RATE_WINDOW_MS = 60_000;
const NONCE_TTL_MS = 10 * 60_000;
const NONCE_MAX = 20_000;

export class HubServer {
  private server: http.Server | null = null;
  private readonly nonces = new Map<string, number>();
  private readonly hits = new Map<string, { count: number; since: number }>();

  constructor(private readonly deps: HubServerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = http.createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        log.warn('offline hub request failed', err);
        if (!res.headersSent) send(res, 500, { error: 'internal' });
      });
    });
    server.requestTimeout = 35_000;
    server.headersTimeout = 10_000;
    this.server = server;
    return new Promise((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        // Port doluysa merkez çalışmaz ama yazdırma etkilenmez.
        log.warn('offline hub port unavailable', { code: err.code });
        this.server = null;
        resolve();
      });
      server.listen(this.deps.port, this.deps.host, () => resolve());
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  address(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host)) return send(res, 403, { error: 'host' });

    const origin = req.headers.origin;
    if (origin !== undefined) {
      const posOrigin = await this.deps.posOrigin();
      if (!posOrigin || origin !== posOrigin) return send(res, 403, { error: 'origin' });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Access-Control-Allow-Local-Network', 'true');
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204).end();
      return;
    }
    if (!this.allow(req.socket.remoteAddress ?? 'unknown')) return send(res, 429, { error: 'rate' });

    const url = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'GET' && url === '/v1/ping') {
      const ping = this.deps.ping();
      return ping ? send(res, 200, ping) : send(res, 503, { error: 'not-hub' });
    }
    if (req.method !== 'POST' || !(HUB_ROUTES as readonly string[]).includes(url)) return send(res, 404, { error: 'not-found' });
    const route = url as HubRoute;

    const hub = this.deps.key();
    if (!hub) return send(res, 503, { error: 'not-hub' });

    const raw = await readBody(req);
    if (raw === 'too-large') return send(res, 413, { error: 'too-large' });
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'json' });
    }
    if (!isEnvelope(envelope)) return send(res, 400, { error: 'envelope' });

    const claims = verifyGrant(hub.key, envelope.g);
    if (!claims || claims.bid !== hub.branchId) return send(res, 401, { error: 'grant' });
    const now = this.now();
    if (claims.exp * 1000 < now) return send(res, 401, { error: 'grant-expired' });
    if (Math.abs(now - envelope.t) > OFFLINE_CLOCK_SKEW_MS) return send(res, 401, { error: 'clock' });
    if (!this.freshNonce(`${claims.gid}:${envelope.n}`, now)) return send(res, 409, { error: 'replay' });

    const secret = grantSecret(hub.key, claims.gid);
    const body = openEnvelope(secret, envelope, 'POST', route);
    if (body === null) return send(res, 400, { error: 'decrypt' });

    const controller = new AbortController();
    req.on('close', () => controller.abort());
    const result = await this.deps.handle(route, claims, body, controller.signal);
    if (res.destroyed) return;
    const sealed = sealEnvelope(secret, { grant: '', method: 'RES', path: route, t: envelope.t, body: result });
    send(res, 200, { n: sealed.n, c: sealed.c });
  }

  private allow(ip: string): boolean {
    const now = this.now();
    const entry = this.hits.get(ip);
    if (!entry || now - entry.since > RATE_WINDOW_MS) {
      this.hits.set(ip, { count: 1, since: now });
      if (this.hits.size > 1000) this.hits.clear();
      return true;
    }
    entry.count += 1;
    return entry.count <= RATE_LIMIT;
  }

  private freshNonce(key: string, now: number): boolean {
    if (this.nonces.has(key)) return false;
    if (this.nonces.size >= NONCE_MAX) {
      for (const [stored, at] of this.nonces) if (now - at > NONCE_TTL_MS) this.nonces.delete(stored);
      if (this.nonces.size >= NONCE_MAX) this.nonces.clear();
    }
    this.nonces.set(key, now);
    return true;
  }
}

/** `Host` başlığının adı yalnızca loopback ya da özel IPv4 olabilir. */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  if (name === 'localhost' || name === '127.0.0.1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function readBody(req: http.IncomingMessage): Promise<string | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > OFFLINE_ENVELOPE_MAX_BYTES) {
        done = true;
        resolve('too-large');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export const PROTOCOL_VERSION = OFFLINE_PROTOCOL_VERSION;
