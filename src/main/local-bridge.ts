import http from 'node:http';
import { log } from './logger';

/**
 * POS SEKMESİ ↔ AJAN, aynı bilgisayarın içinde.
 *
 * Kasadaki POS (https) "müşteri ekranını aç" ve "müşteriye şunu göster"
 * diyebilsin diye ajan 127.0.0.1:47820'de küçük bir HTTP ucu açar. Ağa
 * açılmaz; internetten geçmez.
 *
 * GÜVENLİK — bu uç müşteriye gösterilen tutarı belirliyor; sahte bir tutar
 * göstermek dolandırıcılığın ta kendisi:
 *   - Yalnızca 127.0.0.1'e bağlanır (ağdaki başka makine erişemez).
 *   - `Origin` başlığı POS kökeniyle BİREBİR aynı olmalı; tarayıcı bu başlığı
 *     sayfanın yazmasına izin vermez. Başka her site 403 alır ve CORS
 *     başlığı da yalnızca POS kökenine döner.
 *   - `Host` yalnızca 127.0.0.1/localhost:PORT — DNS rebinding ile bir alan
 *     adını 127.0.0.1'e çözüp kendi kökenini "yerel" gösteren saldırıyı keser.
 *   - Gövde en çok 64 KB, yalnızca JSON; tanınmayan yol 404.
 *   - Aynı makinede çalışan kötü amaçlı bir program bu sınırın dışında: o
 *     zaten kasadaki her şeye erişebilir.
 *
 * Chrome 142+ "yerel ağ erişimi" izni: bir web sitesinin 127.0.0.1'e isteği
 * izin ister. Ajan bu izni de (`LocalNetworkAccessAllowedForUrls`,
 * `LoopbackNetworkAllowedForUrls`) diğer müşteri ekranı izinleriyle birlikte
 * yazar; ön kontrol (preflight) cevabı da gereken başlıkları taşır.
 */

export const LOCAL_BRIDGE_PORT = 47820;
const MAX_BODY = 64 * 1024;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${LOCAL_BRIDGE_PORT}`, `localhost:${LOCAL_BRIDGE_PORT}`]);

export interface BridgeHandlers {
  posOrigin(): Promise<string | null>;
  status(): { configured: boolean; open: boolean };
  open(): Promise<void>;
  close(): void;
  state(payload: unknown): void;
}

export function startLocalBridge(handlers: BridgeHandlers): http.Server {
  const server = http.createServer((req, res) => {
    void handle(req, res, handlers).catch((err) => {
      log.warn('local bridge error', err);
      if (!res.headersSent) send(res, 500, { error: 'internal' });
    });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    // Port doluysa yazdırma etkilenmez; yalnızca müşteri ekranı tarayıcı yoluna düşer.
    log.warn('local bridge unavailable', { code: err.code });
  });
  server.listen(LOCAL_BRIDGE_PORT, '127.0.0.1');
  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, h: BridgeHandlers): Promise<void> {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return send(res, 403, { error: 'host' });

  const origin = await h.posOrigin();
  const requestOrigin = req.headers.origin;
  if (!origin || requestOrigin !== origin) return send(res, 403, { error: 'origin' });

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    // Yerel ağ erişimi ön kontrolü (eski ve yeni adı).
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Local-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
    res.writeHead(204).end();
    return;
  }

  const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
  switch (route) {
    case 'GET /v1/customer-display':
      return send(res, 200, h.status());
    case 'POST /v1/customer-display/open':
      try {
        await h.open();
        return send(res, 200, h.status());
      } catch (err) {
        return send(res, 409, { error: err instanceof Error ? err.message : 'open failed' });
      }
    case 'POST /v1/customer-display/close':
      h.close();
      return send(res, 200, h.status());
    case 'POST /v1/customer-display/state': {
      const body = await readJson(req);
      if (!isDisplayState(body)) return send(res, 400, { error: 'body' });
      h.state(body);
      res.writeHead(204).end();
      return;
    }
    default:
      return send(res, 404, { error: 'not found' });
  }
}

/** POS'taki `CustomerDisplayState` — yalnızca tür alanı doğrulanır; sayfa gerisini çizer. */
function isDisplayState(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'IDLE' || kind === 'ORDER' || kind === 'PAYMENT' || kind === 'PAID';
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return resolve(null);
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
