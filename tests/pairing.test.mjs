/**
 * The pairing handshake, against a server that answers the way the real one does.
 *
 * 0.1.1 could not pair at all: the API wraps every success as `{ data }`, the
 * agent read `deviceToken` off the top level, and the single-use code was spent
 * by the time it gave up — so the operator's retry failed as "invalid code" and
 * the real fault never surfaced. Every fake in this repository replied with the
 * bare object, so the whole suite agreed with the bug.
 *
 * These tests exist to make that class of failure loud: the envelope is
 * asserted, and a bare response is asserted to FAIL rather than being quietly
 * tolerated. Tolerating both shapes would let the fakes drift again.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { normalizePairingCode, pair } from '../dist/main/pairing.js';

const CODE = 'NSDP-25XR';
const DEVICE = { hostname: 'kasa', platform: 'darwin', arch: 'arm64', appVersion: '0.1.2' };

const PAIRED = {
  deviceToken: 'dev-1.key-1',
  deviceId: 'dev-1',
  tenantId: 't1',
  branchId: 'b1',
  tenantName: 'Demo Kafe',
  branchName: 'Merkez',
};

/** `respond` receives the parsed body and returns `[status, payload]`. */
async function withServer(respond, run) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const [status, payload] = respond(body, req);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    // fetch keeps its socket alive, and `close()` alone waits for it forever —
    // the suite would hang at exit rather than fail.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('pairs from an enveloped response — the shape the API actually sends', async () => {
  const paired = await withServer(
    () => [200, { data: PAIRED }],
    (url) => pair(url, CODE, DEVICE),
  );
  assert.deepEqual(paired, PAIRED);
});

test('a bare response is refused, and says the code is spent', async () => {
  // The server answered 200, so it burned the code. Sending the operator back
  // for a fresh one is the only honest advice; "try again" is not.
  await assert.rejects(
    withServer(
      () => [200, PAIRED],
      (url) => pair(url, CODE, DEVICE),
    ),
    /yeni bir kod/i,
  );
});

test('the code reaches the server in the canonical dashed form', async () => {
  const seen = [];
  await withServer(
    (body) => {
      seen.push(body.code);
      return [200, { data: PAIRED }];
    },
    (url) => pair(url, ' nsdp25xr ', DEVICE),
  );
  assert.deepEqual(seen, ['NSDP-25XR']);
});

test('a malformed code never reaches the network', async () => {
  let called = false;
  await withServer(
    () => {
      called = true;
      return [200, { data: PAIRED }];
    },
    async (url) => {
      // Seven characters, and a confusable the backend's alphabet excludes.
      await assert.rejects(pair(url, 'NSDP25X', DEVICE), /8 karakter/);
      await assert.rejects(pair(url, 'NSDP-25XO', DEVICE), /8 karakter/);
    },
  );
  assert.equal(called, false, 'a typo must not spend a round trip, or read as a bad code');
});

test('wrong, expired and used all report one message — the backend will not say which', async () => {
  for (const status of [400, 401, 404]) {
    await withServer(
      () => [status, { error: { message: 'nope' } }],
      (url) => assert.rejects(pair(url, CODE, DEVICE), /Kod geçersiz veya süresi dolmuş/),
    );
  }
});

test('normalizePairingCode accepts what a person types, and only that', () => {
  assert.equal(normalizePairingCode('nsdp25xr'), 'NSDP-25XR');
  assert.equal(normalizePairingCode('  NSDP-25XR '), 'NSDP-25XR');
  assert.equal(normalizePairingCode('NSDP 25XR'), 'NSDP-25XR');

  assert.equal(normalizePairingCode('NSDP25X'), null, 'seven characters');
  assert.equal(normalizePairingCode('NSDP25XRR'), null, 'nine characters');
  // Confusables are excluded at generation, so seeing one means it was misread.
  for (const bad of ['NSDP25X0', 'NSDP25XO', 'NSDP25XI', 'NSDP25XL', 'NSDP25XU', 'NSDP-25X1']) {
    assert.equal(normalizePairingCode(bad), null, bad);
  }
});
