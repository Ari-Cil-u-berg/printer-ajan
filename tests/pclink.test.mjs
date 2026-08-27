/**
 * Hugin PC Link istemcisi — GERÇEK bir HTTPS sunucusuna karşı.
 *
 * `fetch` sahtelemek yerine gerçek TLS kullanılıyor, çünkü test edilen şeylerin
 * ikisi taşımanın kendisinde: kendinden imzalı sertifikanın kabul edilmesi ve
 * parmak izinin sabitlenmesi. Sahte bir istemci bu ikisini de test dışında
 * bırakır ve sahada ilk bağlantıda patlar.
 *
 * Sertifika testin içinde openssl ile üretiliyor. Repoya sabit bir anahtar
 * koymak, "bu anahtar bir yerde gerçek mi" sorusunu her güvenlik denetiminde
 * yeniden sordurur.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isPrivateHost, PcLinkClient, PcLinkError } from '../dist/main/okc/pclink.js';

// --- saf kontroller ---------------------------------------------------------

test('isPrivateHost yalnızca yerel ağ adreslerini kabul eder', () => {
  for (const host of [
    '192.168.1.50', '10.0.0.4', '172.16.3.9', '172.31.255.254',
    '127.0.0.1', '169.254.10.2', 'kasa.local', 'localhost',
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  // Genel adresler ajanı internete istek yapan bir araca çevirirdi.
  for (const host of [
    '8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.9.9',
    '203.0.113.7', 'evil.example.com', '11.0.0.1', '192.999.1.1',
  ]) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('genel adresle istemci kurulamaz', () => {
  assert.throws(() => new PcLinkClient({ host: '8.8.8.8', port: 4443 }), PcLinkError);
});

// --- gerçek TLS -------------------------------------------------------------

function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pclink-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return { dir, key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

let tls;
try {
  tls = makeCert();
} catch {
  tls = null; // openssl yok — TLS testleri atlanır, saf kontroller yine koşar.
}

/** İsteği sırayla verilen cevaplarla karşılayan tek kullanımlık cihaz taklidi. */
async function withDevice(handler, run) {
  const server = https.createServer({ key: tls.key, cert: tls.cert }, handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await run(port);
  } finally {
    server.close();
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('kendinden imzalı sertifikayı kabul eder ve parmak izini döner', { skip: !tls }, async () => {
  await withDevice(
    (_req, res) => json(res, 200, { status: 'SUCCESS', state: 'IDLE' }),
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      const response = await client.status();
      assert.equal(response.httpStatus, 200);
      assert.equal(response.body.state, 'IDLE');
      // Parmak izi olmadan sabitleme yapılamaz.
      assert.match(response.fingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2})+$/);
    },
  );
});

test('parmak izi değişirse bağlantıyı REDDEDER', { skip: !tls }, async () => {
  await withDevice(
    (_req, res) => json(res, 200, { status: 'SUCCESS', state: 'IDLE' }),
    async (port) => {
      // Aynı ağdaki başka bir makine yazarkasa taklidi yapamamalı.
      const client = new PcLinkClient({
        host: '127.0.0.1',
        port,
        fingerprint: 'AA:BB:CC:DD:EE:FF',
      });
      await assert.rejects(() => client.status(), /sertifikası değişti/);
    },
  );
});

test('belge açar ve sonlandırır', { skip: !tls }, async () => {
  const seen = [];
  await withDevice(
    (req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
        if (req.method === 'POST' && req.url === '/v1/documents') {
          return json(res, 200, { status: 'SUCCESS', documentId: 'doc-1' });
        }
        return json(res, 200, {
          status: 'SUCCESS',
          receiptNo: '0042_0007',
          totals: { documentTotal: '90.00', vatTotal: '8.18' },
        });
      });
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      const started = await client.startDocument('SALE');
      assert.equal(started.body.documentId, 'doc-1');

      const done = await client.finalizeDocument('doc-1', { items: [], payments: [] });
      assert.equal(done.body.receiptNo, '0042_0007');

      assert.deepEqual(
        seen.map((s) => `${s.method} ${s.url}`),
        ['POST /v1/documents', 'PUT /v1/documents/doc-1'],
      );
      assert.equal(JSON.parse(seen[0].body).docCategory, 'SALE');
    },
  );
});

test('206 durumu ham hâliyle taşınır — ödeme alındı, belge kapanmadı', { skip: !tls }, async () => {
  await withDevice(
    (_req, res) => json(res, 206, { status: 'SUCCESS', eftPayment: { amount: '90.00' } }),
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      const response = await client.finalizeDocument('doc-1', {});
      // 206'yı başarı ya da hata diye ezmek, alınmış ödemeyi kaybettirirdi:
      // kararı veren katman ham durumu görmeli.
      assert.equal(response.httpStatus, 206);
      assert.equal(response.body.receiptNo, undefined);
    },
  );
});

test('cihazın hata zarfı olduğu gibi aktarılır', { skip: !tls }, async () => {
  await withDevice(
    (_req, res) =>
      json(res, 400, {
        status: 'ERROR',
        error: { code: 'ERR_NO_PAPER', title: 'Kağıt yok', description: 'Rulo takın' },
      }),
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      const response = await client.finalizeDocument('doc-1', {});
      assert.equal(response.httpStatus, 400);
      assert.equal(response.body.error.code, 'ERR_NO_PAPER');
    },
  );
});

test('ayrıştırılamayan cevabı başarılı SAYMAZ', { skip: !tls }, async () => {
  await withDevice(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>ne olduğu belirsiz</html>');
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      await assert.rejects(() => client.status(), /okunamayan/);
    },
  );
});

test('ulaşılamayan cihaz anlaşılır bir hata verir', async () => {
  // Kapalı bir port: kasiyerin okuyacağı cümle "ECONNREFUSED" olmamalı.
  const client = new PcLinkClient({ host: '127.0.0.1', port: 1 });
  await assert.rejects(() => client.status(), /reddetti|ulaşılamıyor|yanıt vermedi/i);
});

// --- kimlik başlıkları -------------------------------------------------------

/**
 * SAHA CİHAZI DOKÜMANDAN KATI. OpenAPI tanımı `X-HardwareId`/`X-SoftwareId`/
 * `X-SerialNo` başlıklarını `required: false` gösteriyor; gerçek Hugin S1
 * başlıksız her isteği `ERR_UNAUTHORIZED — "X-HardwareId değeri boş olamaz"`
 * ile reddediyor. Dokümana güvenip göndermemek `GET /v1/status` dahil hiçbir
 * çağrının çalışmaması demekti, ve bunu sahada öğrendik.
 */
test('her isteğe kimlik başlıklarını ekler', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', state: 'IDLE' });
    },
    async (port) => {
      const client = new PcLinkClient({
        host: '127.0.0.1',
        port,
        // Aralıkta (8–20) bir değer: kısa olsaydı uzatılırdı ve bu test
        // uzatmayı değil, başlığın geçtiğini doğruluyor.
        hardwareId: 'kasa-birinci',
        softwareId: 'ari-test',
        serialNo: 'FU00001234',
      });
      await client.status();
    },
  );
  assert.equal(headers['x-hardwareid'], 'kasa-birinci');
  assert.equal(headers['x-softwareid'], 'ari-test');
  assert.equal(headers['x-serialno'], 'FU00001234');
});

/** Boş bırakılan alan cihazın reddettiği durum; varsayılana düşmek zorunda. */
test('X-HardwareId asla boş gitmez', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', state: 'IDLE' });
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port, hardwareId: '   ' });
      await client.status();
    },
  );
  assert.ok(headers['x-hardwareid'] && headers['x-hardwareid'].trim().length > 0);
  assert.equal(headers['x-softwareid'], 'ari-adisyon-ajan');
});

/** Uydurulmuş bir sicil, boş bırakmaktan daha kötü bir cevap alır. */
test('sicil bilinmiyorsa X-SerialNo hiç gönderilmez', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', state: 'IDLE' });
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      await client.status();
    },
  );
  assert.equal(headers['x-serialno'], undefined);
});

test('ayarları okur — sicil numarası buradan öğreniliyor', { skip: !tls }, async () => {
  let seenPath = null;
  await withDevice(
    (req, res) => {
      seenPath = req.url;
      json(res, 200, { status: 'SUCCESS', serialNo: 'FU00009876' });
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      const response = await client.settings();
      assert.equal(response.body.serialNo, 'FU00009876');
    },
  );
  assert.equal(seenPath, '/v1/settings');
});

/**
 * CİHAZ UZUNLUK DAYATIYOR: `X-HardwareId` 8–20 karakter. Sahada öğrenildi —
 * `kasa-1` gönderen istek `"8 karakterden kısa ... olamaz"` ile reddedildi.
 * Kurulumcunun yazdığı kısa ad hata olarak dönmemeli; uzatılmalı.
 */
test('kısa bir HardwareId cihazın aralığına uzatılır', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', state: 'IDLE' });
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port, hardwareId: 'kasa-1' });
      await client.status();
    },
  );
  const id = headers['x-hardwareid'];
  assert.ok(id.length >= 8 && id.length <= 20, `uzunluk aralık dışı: ${id.length}`);
  assert.ok(id.startsWith('kasa-1'), 'kurulumcunun yazdığı ad korunmalı');
});

/** Aynı makine her açılışta aynı kimliği göndermeli. */
test('uzatılan HardwareId kararlıdır', { skip: !tls }, async () => {
  const seen = [];
  for (let i = 0; i < 2; i += 1) {
    await withDevice(
      (req, res) => {
        seen.push(req.headers['x-hardwareid']);
        json(res, 200, { status: 'SUCCESS', state: 'IDLE' });
      },
      async (port) => {
        const client = new PcLinkClient({ host: '127.0.0.1', port, hardwareId: 'kasa' });
        await client.status();
      },
    );
  }
  assert.equal(seen[0], seen[1]);
});

test('uzun bir HardwareId 20 karaktere kesilir', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', state: 'IDLE' });
    },
    async (port) => {
      const client = new PcLinkClient({
        host: '127.0.0.1',
        port,
        hardwareId: 'cok-uzun-bir-kasa-adi-buraya-sigmaz',
      });
      await client.status();
    },
  );
  assert.equal(headers['x-hardwareid'].length, 20);
});

/** Varsayılanlar da aralıkta olmalı; makine adı kısa ya da uzun olabilir. */
test('varsayılan kimlikler aralığın içinde kalır', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', state: 'IDLE' });
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      await client.status();
    },
  );
  for (const key of ['x-hardwareid', 'x-softwareid']) {
    const value = headers[key];
    assert.ok(value.length >= 8 && value.length <= 20, `${key} aralık dışı: ${value.length}`);
  }
});
