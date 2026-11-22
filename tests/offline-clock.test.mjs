import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openEnvelope, sealEnvelope } from '../dist/main/offline/crypto.js';
import { OfflineHub } from '../dist/main/offline/hub.js';
import { fakeCipher, grant, HUB_KEY_B64, IDS, snapshot, WAITER_PERMS } from './fixtures/offline.mjs';

/**
 * SAAT KORUMASI (v0.3.35). Kesintide çalışma 24 saatlik izinle sınırlı ve
 * izin süresini merkez kendi saatiyle denetliyor; bilgisayarın saati geri
 * alınarak süre uzatılamamalı. Merkez gördüğü en ileri saati diskine yazar,
 * saat geri giderse (15 dk payla) ya da internet 72 saattir yoksa işlem almaz.
 */

const HOUR = 60 * 60_000;

function fakeCloud(clock) {
  const cloud = { down: false };
  cloud.fetch = async (url) => {
    if (cloud.down) throw new TypeError('fetch failed');
    const json = (data) => ({
      ok: true,
      status: 200,
      headers: new Headers({ date: new Date(clock.server).toUTCString() }),
      json: async () => ({ data }),
    });
    if (url.endsWith('/agent/offline/snapshot')) {
      return json({ hub: true, notModified: false, snapshot: snapshot(), hubKey: HUB_KEY_B64, keyVersion: 1 });
    }
    return json({ results: [] });
  };
  return cloud;
}

function makeHub(cloud, dir, clock) {
  return new OfflineHub({
    apiBaseUrl: () => 'https://api.test',
    pairings: () => [{ deviceId: 'dev-bar', stations: ['BAR'], printable: true }],
    token: () => 'tok-dev-bar',
    enqueue: () => undefined,
    posOrigin: async () => null,
    dataDir: dir,
    cipher: fakeCipher,
    host: '127.0.0.1',
    port: 0,
    fetchImpl: cloud.fetch,
    now: () => clock.local,
    timings: { offlineAfterMs: 30, probeWhileOfflineMs: 60_000, busyRetryMs: 10, errorRetryMs: 10, pollMaxMs: 200, nudgeDebounceMs: 5 },
  });
}

/** İstemci gibi: zarfla `/v1/state` iste. `t` istemcinin saati (merkezin ±5 dk'sı). */
function state(port, g, t) {
  const route = '/v1/state';
  const envelope = sealEnvelope(g.secret, { grant: g.token, method: 'POST', path: route, t, body: { known: null } });
  const payload = JSON.stringify(envelope);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: route,
        headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          const json = text ? JSON.parse(text) : null;
          if (res.statusCode !== 200) return resolve({ status: res.statusCode, error: json?.error });
          resolve({ status: 200, body: openEnvelope(g.secret, { g: '', t, ...json }, 'RES', route) });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function waitFor(predicate, ms = 3000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('saat geri alınınca merkez işlem almaz; en ileri saat yeniden başlatmada da korunur', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-clock-'));
  const clock = { local: Date.now(), server: Date.now() };
  const cloud = fakeCloud(clock);
  let hub = makeHub(cloud, dir, clock);
  await hub.start();
  try {
    await waitFor(() => hub.status().role === 'hub');
    const g = grant(IDS.waiter, 'Zeynep K.', WAITER_PERMS);

    // Normal: işlem alınır.
    assert.equal((await state(hub.port(), g, clock.local)).status, 200);

    // İnternet gitti; 2 saat geçti (merkez bunu gördü).
    cloud.down = true;
    hub.setCloudConnected(false);
    await waitFor(() => hub.status().mode === 'offline');
    clock.local += 2 * HOUR;
    assert.equal((await state(hub.port(), g, clock.local)).status, 200);

    // 10 dk geri: pay içinde (saat düzeltmesi, NTP) — çalışır.
    clock.local -= 10 * 60_000;
    assert.equal((await state(hub.port(), g, clock.local)).status, 200);

    // Saat 1 saat daha geri alındı → reddedilir.
    clock.local -= HOUR;
    const rolled = await state(hub.port(), g, clock.local);
    assert.equal(rolled.status, 503);
    assert.equal(rolled.error, 'clock-rollback');

    // Ajan yeniden başlasa da en ileri saat diskte: yine reddedilir.
    await hub.stop();
    hub = makeHub(cloud, dir, clock);
    await hub.start();
    await waitFor(() => hub.status().listening);
    assert.equal((await state(hub.port(), g, clock.local)).error, 'clock-rollback');

    // Saat doğruya dönünce (en ileri saatin 15 dk yakınına) çalışır.
    clock.local += HOUR + 10 * 60_000;
    assert.equal((await state(hub.port(), g, clock.local)).status, 200);
  } finally {
    await hub.stop();
  }
});

test('internet 72 saattir yoksa merkez işlem almaz (izin geçerli olsa bile)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-clock-'));
  const clock = { local: Date.now(), server: Date.now() };
  const cloud = fakeCloud(clock);
  const hub = makeHub(cloud, dir, clock);
  await hub.start();
  try {
    await waitFor(() => hub.status().role === 'hub');
    cloud.down = true;
    hub.setCloudConnected(false);
    await waitFor(() => hub.status().mode === 'offline');

    // Uzun ömürlü (sunucunun vermediği) bir izinle bile 72 saatin ötesi kapalı.
    const exp = Math.floor(clock.local / 1000) + 10 * 24 * 3600;
    const g = grant(IDS.waiter, 'Zeynep K.', WAITER_PERMS, { exp });
    clock.local += 71 * HOUR;
    assert.equal((await state(hub.port(), g, clock.local)).status, 200);
    clock.local += 2 * HOUR;
    const late = await state(hub.port(), g, clock.local);
    assert.equal(late.status, 503);
    assert.equal(late.error, 'offline-too-long');
  } finally {
    await hub.stop();
  }
});

test('bilgisayarın saati ileri kalmışsa, buluta ulaşınca en ileri saat sunucu saatine çekilir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-clock-'));
  const real = Date.now();
  // Saat 3 saat ileri kurulmuş; merkez o saati gördü.
  const clock = { local: real + 3 * HOUR, server: real };
  const cloud = fakeCloud(clock);
  const hub = makeHub(cloud, dir, clock);
  await hub.start();
  try {
    await waitFor(() => hub.status().role === 'hub');
    const g = grant(IDS.waiter, 'Zeynep K.', WAITER_PERMS);
    assert.equal((await state(hub.port(), g, clock.local)).status, 200);

    // Saat düzeltildi (Windows saat eşitlemesi) ve bulut yine ulaşılabilir.
    clock.local = real;
    await hub.refresh();
    // Kesinti geldi: yanlışlıkla "saat geri alındı" denmemeli.
    cloud.down = true;
    hub.setCloudConnected(false);
    await waitFor(() => hub.status().mode === 'offline');
    assert.equal((await state(hub.port(), g, clock.local)).status, 200);
  } finally {
    await hub.stop();
  }
});
