import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openEnvelope, sealEnvelope } from '../dist/main/offline/crypto.js';
import { OfflineHub } from '../dist/main/offline/hub.js';
import {
  base,
  CASHIER_PERMS,
  fakeCipher,
  grant,
  HUB_KEY,
  HUB_KEY_B64,
  IDS,
  local,
  sign,
  snapshot,
  WAITER_PERMS,
} from './fixtures/offline.mjs';

const POS = 'https://pos.ariadisyon.com';
const PAIRINGS = [
  { deviceId: 'dev-bar', stations: ['BAR'], printable: true },
  { deviceId: 'dev-kitchen', stations: ['KITCHEN'], printable: true },
  { deviceId: 'dev-kasa', stations: ['CASHIER'], printable: true },
];

/** Sahte bulut: yalnız dev-bar merkez; sync'e gelen işlemleri sırayla kaydeder. */
function fakeCloud() {
  const cloud = { down: false, hubDevice: 'dev-bar', synced: [], batches: [], reject: new Set(), snapshotCalls: 0 };
  cloud.fetch = async (url, init) => {
    if (cloud.down) throw new TypeError('fetch failed');
    const token = init.headers.Authorization.slice('Bearer '.length);
    const body = JSON.parse(init.body);
    const json = (data, status = 200) => ({ ok: status < 300, status, json: async () => ({ data }) });
    if (url.endsWith('/agent/offline/snapshot')) {
      cloud.snapshotCalls += 1;
      if (token !== `tok-${cloud.hubDevice}`) return json({ hub: false });
      return json({ hub: true, notModified: false, snapshot: snapshot(), hubKey: HUB_KEY_B64, keyVersion: 1 });
    }
    if (url.endsWith('/agent/offline/sync')) {
      cloud.batches.push({ size: body.ops.length, final: body.final });
      const results = body.ops.map((entry) => {
        cloud.synced.push(entry);
        return cloud.reject.has(entry.op.opId)
          ? { opId: entry.op.opId, status: 'rejected', code: 'FORBIDDEN', message: 'yetki' }
          : { opId: entry.op.opId, status: 'applied' };
      });
      return json({ results });
    }
    return json({}, 404);
  };
  return cloud;
}

function makeHub(cloud, dir, jobs) {
  return new OfflineHub({
    apiBaseUrl: () => 'https://api.test',
    pairings: () => PAIRINGS,
    token: (deviceId) => `tok-${deviceId}`,
    enqueue: (job) => jobs.push(job),
    posOrigin: async () => POS,
    dataDir: dir,
    cipher: fakeCipher,
    host: '127.0.0.1',
    port: 0,
    fetchImpl: cloud.fetch,
    timings: { offlineAfterMs: 40, probeWhileOfflineMs: 60, busyRetryMs: 10, errorRetryMs: 10, pollMaxMs: 400, nudgeDebounceMs: 5 },
  });
}

/** Ham HTTP — Host ve Origin başlıklarını testin kendisi belirler. */
function raw(port, { method = 'POST', path: urlPath = '/v1/state', host = `127.0.0.1:${port}`, origin, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          host,
          ...(origin ? { origin } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** İstemci tarafı: zarfla gönder, cevabı aç. */
async function call(port, g, route, body, extra = {}) {
  const t = extra.t ?? Date.now();
  const envelope = sealEnvelope(g.secret, { grant: g.token, method: 'POST', path: route, t, body });
  const res = await raw(port, { path: route, body: extra.envelope ?? envelope, ...extra });
  if (res.status !== 200) return { status: res.status, error: res.json?.error, envelope };
  return { status: 200, body: openEnvelope(g.secret, { g: '', t, ...res.json }, 'RES', route), envelope };
}

async function waitFor(predicate, ms = 3000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const waiter = grant(IDS.waiter, 'Zeynep K.', WAITER_PERMS);
const cashier = grant(IDS.cashier, 'Can Ö.', CASHIER_PERMS);

test('yerel merkez: güvenlik, kesinti, fiş, yoklama, yeniden başlatma, aktarım, rol bırakma', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-hub-'));
  const cloud = fakeCloud();
  const jobs = [];
  let hub = makeHub(cloud, dir, jobs);
  await hub.start();
  t.after(() => hub.stop());
  await waitFor(() => hub.status().role === 'hub');
  const port = hub.port();

  await t.test('ping: merkez, internet var', async () => {
    const res = await raw(port, { method: 'GET', path: '/v1/ping' });
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, 'online');
    assert.equal(res.json.branchId, 'b1');
    assert.equal(JSON.stringify(res.json).includes(HUB_KEY_B64), false);
  });

  await t.test('güvenlik: Host, Origin, ön kontrol, zarf, izin, saat, tekrar, boyut', async () => {
    assert.equal((await raw(port, { method: 'GET', path: '/v1/ping', host: 'evil.example:47821' })).status, 403);
    assert.equal((await raw(port, { method: 'GET', path: '/v1/ping', origin: 'https://evil.example' })).status, 403);
    const cors = await raw(port, { method: 'GET', path: '/v1/ping', origin: POS });
    assert.equal(cors.headers['access-control-allow-origin'], POS);
    const preflight = await raw(port, { method: 'OPTIONS', path: '/v1/ops', origin: POS });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-private-network'], 'true');

    assert.equal((await raw(port, { body: { hello: 1 } })).status, 400);
    assert.equal((await raw(port, { body: 'not json' })).status, 400);

    const foreign = grant(IDS.waiter, 'x', WAITER_PERMS, { bid: 'b2' });
    assert.equal((await call(port, foreign, '/v1/state', {})).status, 401);
    const expired = grant(IDS.waiter, 'x', WAITER_PERMS, { exp: Math.floor(Date.now() / 1000) - 10 });
    assert.equal((await call(port, expired, '/v1/state', {})).error, 'grant-expired');
    const forged = grant(IDS.waiter, 'x', WAITER_PERMS, { key: Buffer.alloc(32, 7) });
    assert.equal((await call(port, forged, '/v1/state', {})).status, 401);
    assert.equal((await call(port, waiter, '/v1/state', {}, { t: Date.now() - 10 * 60_000 })).error, 'clock');

    const ok = await call(port, waiter, '/v1/state', {});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.orders.length, 1);
    assert.ok(ok.body.static.products.length === 2);
    // Aynı zarf ikinci kez: tekrar saldırısı.
    assert.equal((await raw(port, { path: '/v1/state', body: ok.envelope })).status, 409);
    assert.equal((await raw(port, { body: 'x'.repeat(300 * 1024) })).status, 413);
  });

  await t.test('kesinti: bulut 10 sn (testte 40 ms) yoksa mod offline', async () => {
    cloud.down = true;
    hub.setCloudConnected(false);
    await waitFor(async () => (await raw(port, { method: 'GET', path: '/v1/ping' })).json.mode === 'offline');
  });

  const orderRef = local();
  await t.test('S2: garson masa açar, ürün gönderir; bar ve mutfak fişi kendi yazıcısına', async () => {
    const before = jobs.length;
    const ops = [
      sign(waiter, { ...base(IDS.waiter), kind: 'OPEN_TABLE', orderRef, tableId: IDS.t1 }),
      sign(waiter, {
        ...base(IDS.waiter),
        kind: 'ADD_ITEMS',
        orderRef,
        sent: true,
        snapshotId: snapshot().snapshotId,
        items: [
          { itemRef: local(), productId: IDS.latte, qty: 2, unitPrice: '100.00' },
          { itemRef: local(), productId: IDS.tost, qty: 1, unitPrice: '150.00' },
        ],
      }),
    ];
    const res = await call(port, waiter, '/v1/ops', { ops });
    assert.deepEqual(res.body.results.map((r) => r.status), ['applied', 'applied']);
    const printed = jobs.slice(before);
    assert.deepEqual(printed.map((j) => j.route).sort(), ['dev-bar', 'dev-kitchen']);
    assert.ok(printed.every((j) => j.jobId.startsWith('offline:') && j.content.orderNo === 'Ç-1' && j.content.tableName === 'Masa 1'));
    assert.match(printed[0].content.footer, /ÇEVRİMDIŞI/);
  });

  await t.test('başkasının izniyle imzalanmış işlem reddedilir', async () => {
    const op = sign(cashier, { ...base(IDS.cashier), kind: 'OPEN_TABLE', orderRef: local(), tableId: IDS.t2 });
    const res = await call(port, waiter, '/v1/ops', { ops: [op] });
    assert.equal(res.body.results[0].code, 'MAC_INVALID');
  });

  await t.test('uzun yoklama: başka cihazın işlemi bekleyeni uyandırır', async () => {
    const state = await call(port, cashier, '/v1/state', {});
    const waiting = call(port, cashier, '/v1/poll', { since: state.body.seq });
    await new Promise((r) => setTimeout(r, 30));
    await call(port, waiter, '/v1/ops', {
      ops: [sign(waiter, { ...base(IDS.waiter), kind: 'ADD_ITEMS', orderRef, sent: false, snapshotId: snapshot().snapshotId, items: [{ itemRef: local(), productId: IDS.latte, qty: 1, unitPrice: '100.00' }] })],
    });
    const woke = await waiting;
    assert.ok(woke.body.seq > state.body.seq);
    assert.equal(woke.body.mode, 'offline');
  });

  await t.test('hesap fişi kasa yazıcısına, toplamlarla', async () => {
    const before = jobs.length;
    const res = await call(port, cashier, '/v1/bill', { orderRef });
    assert.equal(res.body.ok, true);
    const bill = jobs[before];
    assert.equal(bill.route, 'dev-kasa');
    assert.equal(bill.content.kind, 'BILL');
    assert.equal(bill.content.totals.at(-1).value, '450,00 TL');
  });

  await t.test('S14: ajan kesinti ortasında yeniden başlar → günlük şifreli diskte, kayıp yok', async () => {
    const pending = hub.status().pending;
    assert.equal(pending, 3);
    const file = fs.readFileSync(path.join(dir, 'offline-hub.bin'), 'utf8');
    assert.ok(file.startsWith('ENC:'), 'disk verisi şifreli');
    assert.equal(file.includes('Zeynep'), false);
    await hub.stop();
    hub = makeHub(cloud, dir, jobs);
    await hub.start();
    assert.equal(hub.status().pending, 3);
    assert.equal(hub.status().mode, 'offline');
  });

  await t.test('S7/S15: 250 işlem, internet gelince sırayla 100\'lük partilerle aktarılır; aktarım sırasında gelen de gider', async () => {
    const port2 = hub.port();
    for (let i = 0; i < 125; i += 1) {
      const ref = local();
      await call(port2, cashier, '/v1/ops', {
        ops: [
          sign(cashier, { ...base(IDS.cashier), kind: 'OPEN_TAKEAWAY', orderRef: ref, items: [{ itemRef: local(), productId: IDS.latte, qty: 1, unitPrice: '100.00' }] }),
          sign(cashier, { ...base(IDS.cashier), kind: 'PAY', orderRef: ref, method: 'CASH', amount: '100.00' }),
        ],
      });
    }
    assert.equal(hub.status().pending, 253);
    const rejectedOp = cloud.reject;
    const secondOp = JSON.parse(fakeCipher.decrypt(fs.readFileSync(path.join(dir, 'offline-hub.bin')))).log[1].op.opId;
    rejectedOp.add(secondOp);

    cloud.down = false;
    hub.setCloudConnected(true);
    // Aktarım başladı; bu arada yeni bir sipariş gelir (S15).
    const late = sign(cashier, { ...base(IDS.cashier), kind: 'OPEN_TAKEAWAY', orderRef: local(), items: [{ itemRef: local(), productId: IDS.tost, qty: 1, unitPrice: '150.00' }] });
    const lateRes = await call(port2, cashier, '/v1/ops', { ops: [late] });
    assert.equal(lateRes.body.results[0].status, 'applied');
    await waitFor(() => hub.status().pending === 0 && hub.status().mode === 'online', 5000);

    assert.ok(cloud.batches.every((b) => b.size <= 100));
    assert.equal(cloud.batches.filter((b) => b.final).length >= 1, true);
    const seqs = cloud.synced.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'sıra korunur');
    assert.equal(new Set(cloud.synced.map((e) => e.op.opId)).size, cloud.synced.length, 'hiçbir işlem iki kez gönderilmez');
    assert.ok(cloud.synced.some((e) => e.op.opId === late.op.opId));
    assert.equal(cloud.synced[0].offlineNo, 1);
    assert.equal(hub.status().rejected, 1);
  });

  await t.test('merkez rolü kalkınca yerel veri silinir (KVKK)', async () => {
    cloud.hubDevice = 'dev-other';
    hub.nudge();
    await waitFor(() => hub.status().role === 'none');
    assert.equal(fs.existsSync(path.join(dir, 'offline-hub.bin')), false);
    const res = await raw(hub.port(), { method: 'GET', path: '/v1/ping' });
    assert.equal(res.status, 503);
  });
});
