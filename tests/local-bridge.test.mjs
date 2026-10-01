/**
 * POS sekmesi → ajan yerel köprüsü. Bu uç müşteriye gösterilen tutarı
 * belirliyor; kimin konuşabildiği burada sabitlenir.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { LOCAL_BRIDGE_PORT, startLocalBridge } from '../dist/main/local-bridge.js';

const POS = 'https://pos.ariadisyon.com';
const states = [];
let opened = 0;
const server = startLocalBridge({
  posOrigin: async () => POS,
  status: () => ({ configured: true, open: opened > 0 }),
  open: async () => { opened += 1; },
  close: () => {},
  state: (payload) => states.push(payload),
});

function request(method, path, { origin = POS, host = `127.0.0.1:${LOCAL_BRIDGE_PORT}`, body, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: LOCAL_BRIDGE_PORT, method, path, headers: { host, ...(origin ? { origin } : {}), ...(body !== undefined ? { 'content-type': type } : {}) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test.after(() => server.close());

test('POS kökeni: durum, aç, durum gönder', async () => {
  await new Promise((r) => setTimeout(r, 50));
  const status = await request('GET', '/v1/customer-display');
  assert.equal(status.status, 200);
  assert.equal(status.headers['access-control-allow-origin'], POS);

  assert.equal((await request('POST', '/v1/customer-display/open')).status, 200);
  assert.equal(opened, 1);

  const sent = await request('POST', '/v1/customer-display/state', { body: { kind: 'IDLE' } });
  assert.equal(sent.status, 204);
  assert.deepEqual(states.at(-1), { kind: 'IDLE' });
});

test('başka site, kökensiz istek ve DNS rebinding reddedilir', async () => {
  assert.equal((await request('POST', '/v1/customer-display/open', { origin: 'https://evil.com' })).status, 403);
  assert.equal((await request('POST', '/v1/customer-display/open', { origin: null })).status, 403);
  assert.equal((await request('GET', '/v1/customer-display', { host: 'evil.com:47820' })).status, 403);
  const evil = await request('GET', '/v1/customer-display', { origin: 'https://evil.com' });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
});

test('ön kontrol yerel ağ izni başlıklarını taşır', async () => {
  const pre = await request('OPTIONS', '/v1/customer-display/state');
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-private-network'], 'true');
  assert.equal(pre.headers['access-control-allow-local-network'], 'true');
});

test('bozuk, tanınmayan ve büyük gövde reddedilir', async () => {
  const before = states.length;
  assert.equal((await request('POST', '/v1/customer-display/state', { body: 'not json' })).status, 400);
  assert.equal((await request('POST', '/v1/customer-display/state', { body: { kind: 'HACK' } })).status, 400);
  assert.equal((await request('POST', '/v1/customer-display/state', { body: { kind: 'IDLE' }, type: 'text/plain' })).status, 400);
  const big = await request('POST', '/v1/customer-display/state', { body: { kind: 'ORDER', pad: 'x'.repeat(70 * 1024) } }).catch(() => ({ status: 'reset' }));
  assert.notEqual(big.status, 204);
  assert.equal(states.length, before);
  assert.equal((await request('GET', '/v1/nope')).status, 404);
});
