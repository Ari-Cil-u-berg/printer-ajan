/**
 * Local stand-in for the cloud gateway — for developing and soak-testing the agent
 * without the real backend.
 *
 *   node scripts/mock-server.mjs            # prints a pairing code, accepts any device
 *   ARI_API_URL=http://localhost:8787 ARI_WS_URL=ws://localhost:8787/agent npm run dev
 *
 * Type a station name (bar/mutfak) in its terminal to dispatch a test ticket, or
 * `soak 50` to fire 50 jobs and watch the acks.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);
const PAIRING_CODE = (process.env.CODE ?? crypto.randomBytes(3).toString('hex')).toUpperCase();
const tokens = new Set();
const sockets = new Set();
let codeUsed = false;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // Paths mirror the real API: URI-versioned behind the global prefix.
    if (req.url === '/api/v1/agent/pair' && req.method === 'POST') {
      if (body.code !== PAIRING_CODE) return send(404, { message: 'invalid code' });
      if (codeUsed) return send(409, { message: 'code already used' });
      codeUsed = true;
      const deviceToken = crypto.randomUUID();
      tokens.add(deviceToken);
      console.log(`[pair] device paired: ${body.deviceInfo?.hostname}`);
      return send(200, {
        deviceToken,
        deviceId: crypto.randomUUID(),
        tenantId: 'tenant-demo',
        branchId: 'branch-demo',
        tenantName: 'Demo Kafe',
        branchName: 'Merkez',
      });
    }

    if (req.url === '/api/v1/agent/heartbeat' && req.method === 'POST') {
      console.log('[heartbeat]', body.appVersion);
      return send(200, { ok: true });
    }

    if (req.url?.startsWith('/api/v1/agent/latest')) {
      return send(200, { version: '0.1.0', url: 'https://example.invalid/installer', sha256: 'deadbeef' });
    }

    send(404, { message: 'not found' });
  });
});

const wss = new WebSocketServer({ server, path: '/agent' });

wss.on('connection', (ws, req) => {
  const auth = req.headers.authorization ?? '';
  const token = auth.replace(/^Bearer /, '');
  if (!tokens.has(token)) {
    console.log('[ws] rejected unknown token');
    return ws.close(1008, 'unauthorized');
  }
  sockets.add(ws);
  console.log('[ws] agent connected');
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'job.ack') {
      console.log(`[ack] ${msg.payload.jobId} → ${msg.payload.status} (${msg.payload.attempts} deneme)`, msg.payload.error ?? '');
    } else {
      console.log('[ws]', msg.type, JSON.stringify(msg.payload ?? {}));
    }
  });
  ws.on('close', () => { sockets.delete(ws); console.log('[ws] agent disconnected'); });
});

function dispatch(station) {
  const job = {
    jobId: crypto.randomUUID(),
    station,
    copies: 1,
    content: {
      kind: 'ORDER',
      station,
      orderNo: String(100 + Math.floor(Math.random() * 900)),
      tableName: 'Masa 5',
      waiterName: 'Ayşe Öztürk',
      createdAt: new Date().toISOString(),
      items: [
        { qty: 2, name: 'Türk Kahvesi', note: 'Az şekerli', options: ['Yanında su'] },
        { qty: 1, name: 'Ilık Çilekli Cheesecake' },
      ],
      footer: 'Afiyet olsun',
    },
  };
  for (const ws of sockets) ws.send(JSON.stringify({ type: 'job', payload: job }));
  console.log(`[dispatch] ${station} ${job.jobId}`);
}

server.listen(PORT, () => {
  console.log(`mock gateway on http://localhost:${PORT}`);
  console.log(`PAIRING CODE: ${PAIRING_CODE}`);
  console.log('commands: bar | mutfak | soak <n> | revoke');
});

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [cmd, arg] = line.trim().split(/\s+/);
  if (cmd === 'bar') dispatch('BAR');
  else if (cmd === 'mutfak') dispatch('KITCHEN');
  else if (cmd === 'soak') {
    const n = Number(arg) || 20;
    for (let i = 0; i < n; i++) dispatch(i % 2 ? 'BAR' : 'KITCHEN');
  } else if (cmd === 'revoke') {
    tokens.clear();
    for (const ws of sockets) ws.send(JSON.stringify({ type: 'revoked', reason: 'panelden kaldırıldı' }));
    console.log('[revoke] tokens cleared');
  }
});
