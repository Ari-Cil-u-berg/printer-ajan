/**
 * Satış akışı — GERÇEK bir HTTPS yazarkasa taklidine karşı.
 *
 * Bu dosya para yolunu koruyor ve geç yazıldı: ret, `206` ve kayıp cevap
 * arasındaki farkın tamamı burada, ve o fark "müşteriden iki kez tahsil
 * edildi" ile "cihaz kilitli kaldı" arasındaki fark. Sahada ikisini de
 * gördükten sonra eklendi.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OkcManager } from '../dist/main/okc/okc.js';

let tls;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okc-sale-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
     '-days', '1', '-subj', '/CN=localhost'],
    { stdio: 'ignore' },
  );
  tls = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
} catch {
  tls = null;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Yazarkasa taklidi. `calls` her isteği sırasıyla kaydeder — testlerin
 * çoğu "hangi çağrı yapıldı" sorusunu soruyor, cevabın kendisini değil.
 */
async function withDevice(handler, run) {
  const calls = [];
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    handler(req, res, calls);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okc-data-'));
  try {
    const okc = new OkcManager(
      dataDir,
      { host: '127.0.0.1', port, softwareId: '6310077423', serialNo: 'FU00031401' },
      () => {},
    );
    return await run(okc, calls, dataDir);
  } finally {
    server.close();
  }
}

const pendingFile = (dataDir) => path.join(dataDir, 'okc-pending.json');
const document = { items: [{ name: 'Çay', amount: '20.00' }], payments: [] };

test('onaylanan satış fiş numarasını döner ve kayıt bırakmaz', { skip: !tls }, async () => {
  await withDevice(
    (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/documents') {
        return json(res, 200, { status: 'SUCCESS', data: { documentId: 'doc-1' } });
      }
      return json(res, 200, { status: 'SUCCESS', data: { receiptNo: '0042_0007' } });
    },
    async (okc, calls, dataDir) => {
      const result = await okc.sell({ saleId: 's1', document });
      assert.equal(result.status, 'APPROVED');
      assert.equal(result.receiptNo, '0042_0007');
      assert.equal(fs.existsSync(pendingFile(dataDir)), false);
      assert.deepEqual(calls, ['POST /v1/documents', 'PUT /v1/documents/doc-1']);
    },
  );
});

/**
 * SAHADA YAŞANAN HATA. Cihaz "banka terminali bulunamadı" diyerek belgeyi
 * sonlandırmayı reddetti; ajan reddi bildirdi ama belgeyi cihazda AÇIK bıraktı
 * ve kaydını da sildi. Yazarkasa tek belge tuttuğu için sonraki satış "uygun
 * durumda değil" ile düştü ve kasiyer bunu bir önceki satışa bağlayamadı.
 */
test('reddedilen satış belgeyi cihazda kapatır', { skip: !tls }, async () => {
  await withDevice(
    (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/documents') {
        return json(res, 200, { status: 'SUCCESS', data: { documentId: 'doc-2' } });
      }
      if (req.method === 'PUT') {
        return json(res, 400, {
          status: 'ERROR',
          error: { code: 'ERR_NO_EFT', description: 'Banka terminali bulunamadı' },
        });
      }
      return json(res, 200, { status: 'SUCCESS', data: { documentStatus: 'CANCELLED' } });
    },
    async (okc, calls, dataDir) => {
      const result = await okc.sell({ saleId: 's2', document });

      assert.equal(result.status, 'DECLINED');
      assert.equal(result.error, 'Banka terminali bulunamadı');
      // Cihaz yeniden satışa hazır olmalı.
      assert.ok(calls.includes('POST /v1/documents/doc-2/cancel'), 'belge iptal edilmeli');
      assert.equal(fs.existsSync(pendingFile(dataDir)), false);
    },
  );
});

/** İptal de başarısızsa kurtarma kolu ELDE KALIR — kayıt silinmez. */
test('iptal edilemeyen reddedilmiş belge kayıtta kalır', { skip: !tls }, async () => {
  await withDevice(
    (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/documents') {
        return json(res, 200, { status: 'SUCCESS', data: { documentId: 'doc-3' } });
      }
      if (req.method === 'PUT') {
        return json(res, 400, { status: 'ERROR', error: { description: 'Kalem hatalı' } });
      }
      return json(res, 500, { status: 'ERROR', error: { description: 'İptal edilemedi' } });
    },
    async (okc, calls, dataDir) => {
      const result = await okc.sell({ saleId: 's3', document });
      assert.equal(result.status, 'DECLINED');
      assert.equal(fs.existsSync(pendingFile(dataDir)), true, 'kayıt korunmalı');
    },
  );
});

/**
 * `206` = ÖDEME ALINDI, belge kapanmadı. İptal ETMİYORUZ: alınmış bir ödemenin
 * mali karşılığını silmek olurdu. Kayıt duruyor, karar kasiyerin.
 */
test('206 sonrası belge iptal edilmez ve kayıt korunur', { skip: !tls }, async () => {
  await withDevice(
    (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/documents') {
        return json(res, 200, { status: 'SUCCESS', data: { documentId: 'doc-4' } });
      }
      return json(res, 206, { status: 'SUCCESS', data: { eftPayment: { amount: '90.00' } } });
    },
    async (okc, calls, dataDir) => {
      const result = await okc.sell({ saleId: 's4', document });

      assert.equal(result.status, 'UNKNOWN');
      assert.ok(!calls.some((c) => c.includes('/cancel')), 'ödeme alınmışken iptal edilmemeli');
      assert.equal(fs.existsSync(pendingFile(dataDir)), true);
    },
  );
});

/** Belge hiç açılmadıysa iptal edilecek bir şey de yok. */
test('belge açılamadıysa iptal denenmez', { skip: !tls }, async () => {
  await withDevice(
    (req, res) =>
      json(res, 409, {
        status: 'ERROR',
        error: { description: 'Cihaz, istenen işlemi gerçekleştirmek için uygun durumda değil' },
      }),
    async (okc, calls, dataDir) => {
      const result = await okc.sell({ saleId: 's5', document });

      assert.equal(result.status, 'DECLINED');
      assert.match(result.error, /uygun durumda değil/);
      assert.ok(!calls.some((c) => c.includes('/cancel')));
      assert.equal(fs.existsSync(pendingFile(dataDir)), false);
    },
  );
});

/**
 * KASADAN İPTAL — cihaz beklemeden dönmeli.
 *
 * Sahada: kasiyer POS'tan iptal etti, ekran "İPTAL EDİLDİ" dedi, cihaz kart
 * beklemeye iki dakika daha devam etti. İki ekran iki farklı gerçek gösterdi.
 * İptal artık cihazda belgeyi kapatıyor ve bekleyen isteği düşürüyor.
 */
test('kasadan iptal belgeyi kapatır ve satışı hemen bitirir', { skip: !tls }, async () => {
  await withDevice(
    (req, res, calls) => {
      if (req.method === 'POST' && req.url === '/v1/documents') {
        return json(res, 200, { status: 'SUCCESS', data: { documentId: 'doc-9' } });
      }
      if (req.url.endsWith('/cancel')) {
        return json(res, 200, { status: 'SUCCESS', data: { documentStatus: 'CANCELLED' } });
      }
      // `Belge Sonlandır` kartı bekliyor — cevabı hiç vermiyoruz.
      void calls;
    },
    async (okc, calls, dataDir) => {
      const sale = okc.sell({ saleId: 's9', document });
      // Belgenin açılıp bekleme durumuna geçmesini bekle.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const cancelled = await okc.cancelSale('s9');
      assert.equal(cancelled.ok, true);

      const result = await sale;
      // RET, "bilmiyorum" DEĞİL: belgeyi biz kapattık, ödeme başlamadı.
      assert.equal(result.status, 'DECLINED');
      assert.equal(result.error, 'Kasadan iptal edildi');
      assert.ok(calls.includes('POST /v1/documents/doc-9/cancel'));
      assert.equal(fs.existsSync(pendingFile(dataDir)), false);
    },
  );
});

/**
 * KURTARMA DENEMESİ CİHAZI İLK SATIŞTAN KÖTÜ BIRAKMAZ.
 *
 * `retryPending` reddi alınca kaydı siliyor ama belgeyi cihazda açık
 * bırakıyordu — `sell` yolunun tam tersi. Sonuç: sahipsiz açık belge, elde
 * kayıt yok, sonraki satış "uygun durumda değil".
 */
test('tekrar denemede reddedilen belge cihazda kapatılır', { skip: !tls }, async () => {
  // İlk satış `206` ile biter (ödeme alındı, fiş kapanmadı) ve kayıt bırakır;
  // `sell` içindeki iki tekrarla birlikte üç `PUT` eder. Kasiyerin tekrar
  // denemesi dördüncüsüdür ve cihaz onu reddeder.
  let puts = 0;
  await withDevice(
    (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/documents') {
        return json(res, 200, { status: 'SUCCESS', data: { documentId: 'doc-11' } });
      }
      if (req.url.endsWith('/cancel')) {
        return json(res, 200, { status: 'SUCCESS', data: { documentStatus: 'CANCELLED' } });
      }
      puts += 1;
      return puts > 3
        ? json(res, 400, { status: 'ERROR', error: { description: 'Kalem hatalı' } })
        : json(res, 206, { status: 'SUCCESS', data: {} });
    },
    async (okc, calls, dataDir) => {
      const first = await okc.sell({ saleId: 's11', document });
      assert.equal(first.status, 'UNKNOWN');
      assert.equal(fs.existsSync(pendingFile(dataDir)), true);

      const retried = await okc.retryPending();
      assert.equal(retried.status, 'DECLINED');
      assert.ok(calls.includes('POST /v1/documents/doc-11/cancel'), 'belge kapatılmalı');
      assert.equal(fs.existsSync(pendingFile(dataDir)), false);
    },
  );
});

/**
 * "İPTAL ETTİM" DEMEK, CİHAZIN ETTİĞİ ANLAMINA GELMEZ.
 *
 * `cancelPending` cevabın HTTP durumunu hiç okumuyordu: cihaz reddetse bile
 * kasiyere `ok` dönüyor ve kayıt siliniyordu — kurtarma kolu, tam lazım olduğu
 * anda atılıyordu.
 */
test('cihaz iptali reddederse bekleyen kayıt korunur', { skip: !tls }, async () => {
  await withDevice(
    (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/documents') {
        return json(res, 200, { status: 'SUCCESS', data: { documentId: 'doc-12' } });
      }
      if (req.url.endsWith('/cancel')) {
        return json(res, 409, {
          status: 'ERROR',
          error: { description: 'Belge iptal edilebilir durumda değil' },
        });
      }
      return json(res, 206, { status: 'SUCCESS', data: {} });
    },
    async (okc, calls, dataDir) => {
      const sale = await okc.sell({ saleId: 's12', document });
      assert.equal(sale.status, 'UNKNOWN');

      const cancelled = await okc.cancelPending();
      assert.equal(cancelled.ok, false, 'cihazın reddi başarı sayılmamalı');
      assert.match(cancelled.error, /iptal edilebilir durumda değil/);
      assert.equal(fs.existsSync(pendingFile(dataDir)), true, 'kayıt korunmalı');
    },
  );
});

/** Başka bir adisyonun belgesi iptal edilmemeli. */
test('adı geçmeyen satış için iptal reddedilir', { skip: !tls }, async () => {
  await withDevice(
    (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/documents') {
        return json(res, 200, { status: 'SUCCESS', data: { documentId: 'doc-10' } });
      }
      if (req.url.endsWith('/cancel')) {
        return json(res, 200, { status: 'SUCCESS', data: {} });
      }
      return json(res, 200, { status: 'SUCCESS', data: { receiptNo: '0042_0009' } });
    },
    async (okc, calls) => {
      const sale = okc.sell({ saleId: 's10', document });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const wrong = await okc.cancelSale('baska-adisyon');
      assert.equal(wrong.ok, false);
      assert.match(wrong.error, /beklemiyor/);
      assert.ok(!calls.some((c) => c.includes('/cancel')), 'yanlış belge kapatılmamalı');

      const result = await sale;
      assert.equal(result.status, 'APPROVED');
    },
  );
});
