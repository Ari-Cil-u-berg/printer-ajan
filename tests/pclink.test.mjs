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
    (_req, res) => json(res, 200, { status: 'SUCCESS', data: { state: 'IDLE' } }),
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      const response = await client.status();
      assert.equal(response.httpStatus, 200);
      assert.equal(response.data.state, 'IDLE');
      // Parmak izi olmadan sabitleme yapılamaz.
      assert.match(response.fingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2})+$/);
    },
  );
});

test('parmak izi değişirse bağlantıyı REDDEDER', { skip: !tls }, async () => {
  await withDevice(
    (_req, res) => json(res, 200, { status: 'SUCCESS', data: { state: 'IDLE' } }),
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
          return json(res, 200, { status: 'SUCCESS', data: { documentId: 'doc-1' } });
        }
        return json(res, 200, {
          status: 'SUCCESS',
          data: {
            receiptNo: '0042_0007',
            totals: { documentTotal: '90.00', vatTotal: '8.18' },
          },
        });
      });
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      const started = await client.startDocument('SALE');
      assert.equal(started.data.documentId, 'doc-1');

      const done = await client.finalizeDocument('doc-1', { items: [], payments: [] });
      assert.equal(done.data.receiptNo, '0042_0007');

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
      assert.equal(response.data.receiptNo, undefined);
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
      json(res, 200, { status: 'SUCCESS', data: { state: 'IDLE' } });
    },
    async (port) => {
      const client = new PcLinkClient({
        host: '127.0.0.1',
        port,
        hardwareId: 'kasa-birinci',
        softwareId: '6310077423',
        serialNo: 'FU00001234',
      });
      await client.status();
    },
  );
  assert.equal(headers['x-hardwareid'], 'kasa-birinci');
  assert.equal(headers['x-softwareid'], '6310077423');
  assert.equal(headers['x-serialno'], 'FU00001234');
});

/**
 * KASA KİMLİĞİ BOŞSA VKN'YE DÜŞER, MAKİNE ADINA DEĞİL.
 *
 * Eskiden `hostname()` gönderiliyordu ve cihaz `"x-hardwareid eşleşmiyor"`
 * diyordu: başlık bizim seçtiğimiz bir ad değil, cihazda kayıtlı bir değer.
 * Makine adı orada kayıtlı olamaz; VKN cihazın tanıdığı tek numaradır.
 */
test('HardwareId boşsa VKN gönderilir', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', data: { state: 'IDLE' } });
    },
    async (port) => {
      // Boşluk da boş sayılır — kurulumcunun sekmeye basması bir kimlik değil.
      const client = new PcLinkClient({
        host: '127.0.0.1',
        port,
        hardwareId: '   ',
        softwareId: '6310077423',
      });
      await client.status();
    },
  );
  assert.equal(headers['x-hardwareid'], '6310077423');
});

/**
 * İkisi de bilinmiyorsa başlık HİÇ GİTMEZ. Cihaz "boş olamaz" der ve bu doğru
 * hatadır; uydurulmuş bir kimlik "eşleşmiyor" der ve sebebi görünmez olur.
 */
test('HardwareId ve VKN yoksa başlık hiç gönderilmez', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', data: { state: 'IDLE' } });
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      await client.status();
    },
  );
  assert.equal(headers['x-hardwareid'], undefined);
});

/**
 * VKN UYDURULMAZ. `X-SoftwareId`, PC Link'e girilen vergi numarasıyla birebir
 * eşleşmek zorunda; yerine bir varsayılan koymak, cihazın her isteği
 * "eşleşmiyor" ile reddetmesi ve sebebin uydurduğumuz değer olması demekti.
 */
test('VKN girilmemişse X-SoftwareId hiç gönderilmez', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', data: { state: 'IDLE' } });
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      await client.status();
    },
  );
  assert.equal(headers['x-softwareid'], undefined);
});

/** Uydurulmuş bir sicil, boş bırakmaktan daha kötü bir cevap alır. */
test('sicil bilinmiyorsa X-SerialNo hiç gönderilmez', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', data: { state: 'IDLE' } });
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
      json(res, 200, { status: 'SUCCESS', data: { serialNo: 'FU00009876' } });
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      const response = await client.settings();
      assert.equal(response.data.serialNo, 'FU00009876');
    },
  );
  assert.equal(seenPath, '/v1/settings');
});

/**
 * KİMLİK NORMALLEŞTİRİLMEZ — bu test bir regresyonu tutuyor.
 *
 * Uzunca `X-HardwareId`'yi serbest bir etiket sandık: cihazın "8 karakterden
 * kısa, 20 karakterden uzun olamaz" uyarısını bir biçim kısıtı okuyup kısa
 * olanı sha256 ekiyle uzattık, uzun olanı 20'ye kestik, `[A-Za-z0-9._-]`
 * dışındaki karakterleri ayıkladık. Cihaz `"x-hardwareid eşleşmiyor"` diyerek
 * bunu çürüttü: aralık bir kural değil, beklenen değerin kendi uzunluğuymuş.
 *
 * Üç dönüşümün üçü de eşleşmesi gereken bir değeri bozuyordu. Hiçbiri geri
 * gelmemeli.
 */
test('HardwareId olduğu gibi gider — kesilmez, uzatılmaz, ayıklanmaz', { skip: !tls }, async () => {
  const cases = [
    'kasa-1', // 6 karakter — eskiden uzatılırdı
    'cok-uzun-bir-kasa-adi-buraya-sigmaz', // 35 karakter — eskiden kesilirdi
    '00:1A:2B:3C:4D:5E', // eskiden iki noktalar ayıklanırdı
  ];
  for (const hardwareId of cases) {
    let headers = null;
    await withDevice(
      (req, res) => {
        headers = req.headers;
        json(res, 200, { status: 'SUCCESS', data: { state: 'IDLE' } });
      },
      async (port) => {
        const client = new PcLinkClient({ host: '127.0.0.1', port, hardwareId });
        await client.status();
      },
    );
    assert.equal(headers['x-hardwareid'], hardwareId);
  }
});

/** Girilen kimlik VKN'yi ezer: cihaz farklı bir kimlik bekliyorsa çıkış yolu bu. */
test('girilen HardwareId VKN yerine geçer', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', data: { state: 'IDLE' } });
    },
    async (port) => {
      const client = new PcLinkClient({
        host: '127.0.0.1',
        port,
        hardwareId: 'HGN-0042',
        softwareId: '6310077423',
      });
      await client.status();
    },
  );
  assert.equal(headers['x-hardwareid'], 'HGN-0042');
  assert.equal(headers['x-softwareid'], '6310077423');
});

/**
 * `X-SoftwareId` OLDUĞU GİBİ GİDER — kırpılmaz, uzatılmaz.
 *
 * Bu başlık bir biçim değil bir EŞLEŞME: cihaz, PC Link'e girilen VKN'yi
 * bekliyor. Uzunluk kuralını ("10 karakterden uzun olamaz") bir biçim kısıtı
 * sanıp normalleştirmiştik; oysa on hane, bir VKN'nin kendi uzunluğuymuş.
 * 11 haneli bir TCKN'yi 10'a kesmek garanti bir "eşleşmiyor" üretirdi.
 */
test('VKN olduğu gibi gönderilir', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', data: { state: 'IDLE' } });
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port, softwareId: '6310077423' });
      await client.status();
    },
  );
  assert.equal(headers['x-softwareid'], '6310077423');
});

/** 11 haneli TCKN de kesilmemeli — kesilirse eşleşme imkânsız olur. */
test('11 haneli kimlik numarası kırpılmaz', { skip: !tls }, async () => {
  let headers = null;
  await withDevice(
    (req, res) => {
      headers = req.headers;
      json(res, 200, { status: 'SUCCESS', data: { state: 'IDLE' } });
    },
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port, softwareId: '12345678901' });
      await client.status();
    },
  );
  assert.equal(headers['x-softwareid'], '12345678901');
});

// --- cevap zarfı -------------------------------------------------------------

/**
 * YÜK HER ZAMAN `data` ALTINDA — ve bu bir gün pahalıya patladı.
 *
 * PC Link dokümanının metni alanları düz bir tabloda sayıyor ("documentId |
 * string | Cihaz tarafından belgeye atanan tekil ID") ve biz onları kökte
 * okuyorduk. Şemada ise hepsi `data`'nın içinde; gerçek cihaz şemaya uyuyor.
 *
 * Tek bir yanlış okuma, birbirinden bağımsız görünen üç arıza üretti:
 * `documentId` hiç okunamadı ("Yazarkasa belge açmadı" — oysa cihazın
 * ekranında fiş açıktı), `state` hiç gelmedi (açık belge uyarısı çalışmadı),
 * `serialNo` öğrenilemedi ve `X-SerialNo` gönderilemediği için satış "sicil
 * doğrulanamadı" ile reddedildi.
 */
test('yük `data` altından okunur, zarf ayrı durur', { skip: !tls }, async () => {
  await withDevice(
    (_req, res) =>
      json(res, 200, {
        status: 'SUCCESS',
        data: { documentId: 'doc-42' },
        metadata: { sfaVersion: '1.2.3', timestamp: '2026-08-28T10:00:00+03:00' },
      }),
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port, softwareId: '6310077423' });
      const response = await client.startDocument('SALE');

      assert.equal(response.data.documentId, 'doc-42');
      // Zarf yükle karışmamalı: `status` ve `metadata` orada kalır.
      assert.equal(response.body.status, 'SUCCESS');
      assert.equal(response.body.metadata.sfaVersion, '1.2.3');
      // Kökte yük ARANMAZ — eski hatanın kendisi buydu.
      assert.equal(response.body.documentId, undefined);
    },
  );
});

/** `data` hiç gelmezse çağıran patlamamalı; boş nesne görmeli. */
test('data yoksa boş nesne döner', { skip: !tls }, async () => {
  await withDevice(
    (_req, res) => json(res, 200, { status: 'SUCCESS' }),
    async (port) => {
      const client = new PcLinkClient({ host: '127.0.0.1', port });
      const response = await client.status();
      assert.deepEqual(response.data, {});
    },
  );
});
