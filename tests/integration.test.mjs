/**
 * End-to-end over a real socket: pairing → WS auth → job dispatch → print → ack,
 * plus reconnect-after-gateway-restart and revoke handling. Electron is never
 * loaded; only the transport/queue layers are exercised.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { ConnectionManager } from '../dist/main/connection.js';
import { pair } from '../dist/main/pairing.js';
import { JobQueue } from '../dist/main/queue.js';

// Eight characters from the backend's alphabet — the real shape, so this test
// exercises the code path an operator actually takes.
const CODE = 'A7K2-QPTN';
const TOKEN = 'device-token-1';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ari-int-'));
}

function waitFor(predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 15);
    };
    tick();
  });
}

/** Mock gateway. `port: 0` picks a free port; reuse the port to test reconnect. */
async function startGateway({ port = 0, acceptToken = TOKEN, codeUsed = false } = {}) {
  const state = { connections: 0, acks: [], sockets: new Set(), used: codeUsed };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      // Same versioned path AND the same envelope the real API serves: it wraps
      // every success as `{ data }`. A fake that replies with the bare object
      // agrees with the agent's bug instead of catching it — which is exactly
      // what happened in 0.1.1.
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status < 400 ? { data: payload } : { error: payload }));
      };
      if (req.url === '/api/v1/agent/pair') {
        const bare = (code) => String(code ?? '').replace(/-/g, '');
        if (bare(body.code) !== bare(CODE)) return send(404, { message: 'invalid' });
        if (state.used) return send(409, { message: 'used' });
        state.used = true;
        return send(200, {
          deviceToken: TOKEN,
          deviceId: 'dev-1',
          tenantId: 't1',
          branchId: 'b1',
          tenantName: 'Demo Kafe',
          branchName: 'Merkez',
        });
      }
      send(404, {});
    });
  });

  const wss = new WebSocketServer({ server, path: '/agent' });
  wss.on('connection', (ws, req) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (token !== acceptToken) return ws.close(1008, 'unauthorized');
    state.connections += 1;
    state.sockets.add(ws);
    ws.on('close', () => state.sockets.delete(ws));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'job.ack') state.acks.push(msg.payload);
    });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actualPort = server.address().port;
  return {
    ...state,
    port: actualPort,
    apiUrl: `http://127.0.0.1:${actualPort}`,
    wsUrl: `ws://127.0.0.1:${actualPort}/agent`,
    state,
    dispatch(job) {
      for (const ws of state.sockets) ws.send(JSON.stringify({ type: 'job', payload: job }));
    },
    revoke() {
      for (const ws of state.sockets) ws.send(JSON.stringify({ type: 'revoked', reason: 'test' }));
    },
    async stop() {
      for (const ws of state.sockets) ws.terminate();
      await new Promise((r) => { wss.close(); server.close(r); });
    },
  };
}

const info = { hostname: 'test-pc', platform: 'test', arch: 'x64', appVersion: '0.1.0' };

test('pairing exchanges a short-lived code for a durable token', async () => {
  const gw = await startGateway();
  try {
    const result = await pair(gw.apiUrl, ' a7k2-qptn ', info); // trimmed + upper-cased
    assert.equal(result.deviceToken, TOKEN);
    assert.equal(result.branchName, 'Merkez');

    await assert.rejects(() => pair(gw.apiUrl, CODE, info), /kullanılmış/);
    // Same length and alphabet as a real code, so it reaches the gateway and
    // comes back as "wrong" rather than being refused for its shape.
    await assert.rejects(() => pair(gw.apiUrl, 'WRNG-CDEF', info), /geçersiz|Kod geçersiz/i);
  } finally {
    // Without this a failing assertion leaves the gateway listening, and the
    // test run hangs on the open handle instead of reporting the failure.
    await gw.stop();
  }
});

test('job dispatched over WS is printed once and acked', async () => {
  const gw = await startGateway();
  const dir = tmpDir();
  const printed = [];
  const queue = new JobQueue(dir, async (j) => { printed.push(j.jobId); });
  const conn = new ConnectionManager({
    wsUrl: gw.wsUrl, token: TOKEN, deviceInfo: info, dataDir: dir, queuedCount: () => queue.size(),
  });
  queue.on('ack', (a) => conn.ack(a));
  conn.on('job', (j) => queue.enqueue(j));
  queue.start();
  conn.connect();

  await waitFor(() => conn.getState() === 'CONNECTED');
  const jobId = crypto.randomUUID();
  gw.dispatch({ jobId, station: 'BAR', copies: 1, escpos: 'AA==' });
  await waitFor(() => gw.state.acks.length === 1);

  assert.deepEqual(printed, [jobId]);
  assert.equal(gw.state.acks[0].status, 'printed');

  // Redelivery of the same jobId must not print a second ticket.
  gw.dispatch({ jobId, station: 'BAR', copies: 1, escpos: 'AA==' });
  await waitFor(() => gw.state.acks.length === 2);
  assert.deepEqual(printed, [jobId]);

  conn.close();
  queue.stop();
  await gw.stop();
});

test('reconnects after the gateway restarts and flushes buffered acks', async (t) => {
  const gw = await startGateway();
  const { port } = gw;
  const dir = tmpDir();
  const queue = new JobQueue(dir, async () => {});
  const conn = new ConnectionManager({
    wsUrl: gw.wsUrl, token: TOKEN, deviceInfo: info, dataDir: dir, queuedCount: () => queue.size(),
  });
  let gw2;
  t.after(async () => {
    conn.close();
    queue.stop();
    await gw.stop().catch(() => {});
    await gw2?.stop().catch(() => {});
  });

  queue.on('ack', (a) => conn.ack(a));
  conn.on('job', (j) => queue.enqueue(j));
  queue.start();
  conn.connect();
  await waitFor(() => conn.getState() === 'CONNECTED');

  await gw.stop();
  await waitFor(() => conn.getState() === 'OFFLINE');

  // Job acked while offline — the ack must survive and be delivered on reconnect.
  queue.enqueue({ jobId: 'offline-job', station: 'BAR', copies: 1, escpos: 'AA==' });
  await waitFor(() => readIfExists(path.join(dir, 'ack-outbox.json')).includes('offline-job'));

  gw2 = await startGateway({ port, codeUsed: true });
  await waitFor(() => conn.getState() === 'CONNECTED', 20000);
  await waitFor(() => gw2.state.acks.some((a) => a.jobId === 'offline-job'), 10000);
});

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

test('revocation stops the agent from reconnecting', async () => {
  const gw = await startGateway();
  const dir = tmpDir();
  const conn = new ConnectionManager({
    wsUrl: gw.wsUrl, token: TOKEN, deviceInfo: info, dataDir: dir, queuedCount: () => 0,
  });
  let unauthorized = false;
  conn.on('unauthorized', () => { unauthorized = true; });
  conn.connect();
  await waitFor(() => conn.getState() === 'CONNECTED');

  gw.revoke();
  await waitFor(() => unauthorized);
  assert.equal(conn.getState(), 'UNPAIRED');

  const before = gw.state.connections;
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(gw.state.connections, before, 'must not retry after revocation');

  conn.close();
  await gw.stop();
});

test('a bad token does not spin in a reconnect loop', async () => {
  const gw = await startGateway({ acceptToken: 'other-token' });
  const dir = tmpDir();
  const conn = new ConnectionManager({
    wsUrl: gw.wsUrl, token: 'wrong', deviceInfo: info, dataDir: dir, queuedCount: () => 0,
  });
  conn.connect();
  await new Promise((r) => setTimeout(r, 2000));
  assert.ok(gw.state.connections === 0);
  conn.close();
  await gw.stop();
});
