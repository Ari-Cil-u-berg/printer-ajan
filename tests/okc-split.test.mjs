/**
 * TEK FİŞ, ÇOK ÖDEME — kablolu Hugin'de hesabın bölüşülerek ödenmesi.
 *
 * Her kart parçası AYNI açık belgeye `Parçalı Ödeme Ekle` ile eklenir, nakit
 * cihaza gitmez, son parça belgeyi bütün kalemler ve ödemelerle kapatır.
 * Para yolu: alınmış kart varken belge asla iptal edilmez, başka adisyonun
 * satışı açık fişe karışmaz.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okc-split-'));
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

async function withDevice(handler, run) {
  const calls = [];
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}${body && req.method === 'POST' && req.url.includes('/payments/') ? ` ${body}` : ''}`);
      handler(req, res, calls);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okc-split-data-'));
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

const splitFile = (dataDir) => path.join(dataDir, 'okc-split.json');
const finalDocument = { items: [{ name: 'Test', quantity: '5', unitPrice: '2.00' }], payments: [] };

/** Belgeyi açar, her kartı onaylar, sonlandırmada fiş numarası verir. */
const happyDevice = (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/documents') {
    return json(res, 200, { status: 'SUCCESS', data: { documentId: 'doc-1' } });
  }
  if (req.method === 'POST' && req.url.endsWith('/payments/EFT_POS')) {
    return json(res, 200, { status: 'SUCCESS', data: { transactionId: 2239, amount: '4.00', authorizationCode: '599479' } });
  }
  if (req.method === 'PUT') {
    return json(res, 200, { status: 'SUCCESS', data: { receiptNo: '0042_0009', totals: { documentTotal: '10.00' } } });
  }
  return json(res, 200, { status: 'SUCCESS', data: { documentStatus: 'CANCELLED' } });
};

test('iki kart + son kart: tek belge, her kart ayrı eklenir, son parça kapatır', { skip: !tls }, async () => {
  await withDevice(happyDevice, async (okc, calls, dataDir) => {
    const first = await okc.sellSplit({ saleId: 'p1', key: 'order-1', payment: { type: 'CARD', amount: '4.00' } });
    assert.equal(first.status, 'APPROVED');
    assert.equal(first.receiptNo, undefined);
    assert.equal(first.transactionRef, '599479');
    assert.equal(fs.existsSync(splitFile(dataDir)), true, 'açık fiş diske yazılmalı');
    assert.equal((await okc.refreshHealth()).openSplit?.cardPayments, 1);

    const last = await okc.sellSplit({
      saleId: 'p2',
      key: 'order-1',
      payment: { type: 'CARD', amount: '6.00' },
      document: finalDocument,
    });
    assert.equal(last.status, 'APPROVED');
    assert.equal(last.receiptNo, '0042_0009');
    assert.equal(fs.existsSync(splitFile(dataDir)), false);
    assert.deepEqual(
      calls.filter((call) => !call.startsWith('GET')),
      [
        'POST /v1/documents',
        'POST /v1/documents/doc-1/payments/EFT_POS {"amount":"4.00"}',
        'POST /v1/documents/doc-1/payments/EFT_POS {"amount":"6.00"}',
        'PUT /v1/documents/doc-1',
      ],
    );
  });
});

test('nakit parça cihaza gitmez; nakitle biten fiş yalnızca sonlandırılır', { skip: !tls }, async () => {
  await withDevice(happyDevice, async (okc, calls) => {
    await okc.sellSplit({ saleId: 'p1', key: 'order-1', payment: { type: 'CARD', amount: '4.00' } });
    const cash = await okc.sellSplit({ saleId: 'p2', key: 'order-1', payment: { type: 'CASH', amount: '2.00' } });
    assert.equal(cash.status, 'APPROVED');
    const last = await okc.sellSplit({
      saleId: 'p3',
      key: 'order-1',
      payment: { type: 'CASH', amount: '4.00' },
      document: finalDocument,
    });
    assert.equal(last.status, 'APPROVED');
    assert.deepEqual(
      calls.filter((call) => !call.startsWith('GET')),
      ['POST /v1/documents', 'POST /v1/documents/doc-1/payments/EFT_POS {"amount":"4.00"}', 'PUT /v1/documents/doc-1'],
    );
  });
});

test('açık fiş varken başka adisyonun parçası da tek seferlik satış da reddedilir', { skip: !tls }, async () => {
  await withDevice(happyDevice, async (okc, calls) => {
    await okc.sellSplit({ saleId: 'p1', key: 'order-1', payment: { type: 'CARD', amount: '4.00' } });
    const before = calls.length;

    const other = await okc.sellSplit({ saleId: 'x1', key: 'order-2', payment: { type: 'CARD', amount: '3.00' } });
    const single = await okc.sell({ saleId: 'x2', document: finalDocument });

    assert.equal(other.status, 'DECLINED');
    assert.equal(single.status, 'DECLINED');
    assert.match(single.error, /açık bir fiş/);
    assert.equal(calls.slice(before).filter((call) => !call.startsWith('GET')).length, 0, 'cihaza hiçbir şey gitmemeli');
  });
});

test('ilk kart reddedilirse belge kapatılır, cihaz boşa çıkar', { skip: !tls }, async () => {
  await withDevice(
    (req, res) => {
      if (req.method === 'POST' && req.url.endsWith('/payments/EFT_POS')) {
        return json(res, 417, { status: 'ERROR', error: { code: 'INSUFFICIENT_FUNDS', title: 'Yetersiz bakiye' } });
      }
      return happyDevice(req, res);
    },
    async (okc, calls, dataDir) => {
      const result = await okc.sellSplit({ saleId: 'p1', key: 'order-1', payment: { type: 'CARD', amount: '4.00' } });
      assert.equal(result.status, 'DECLINED');
      assert.ok(calls.includes('POST /v1/documents/doc-1/cancel'));
      assert.equal(fs.existsSync(splitFile(dataDir)), false);
    },
  );
});

test('sonraki kart reddedilirse alınmış kart korunur: belge açık kalır, iptal edilemez', { skip: !tls }, async () => {
  let cards = 0;
  await withDevice(
    (req, res) => {
      if (req.method === 'POST' && req.url.endsWith('/payments/EFT_POS')) {
        cards += 1;
        if (cards === 2) {
          return json(res, 417, { status: 'ERROR', error: { code: 'INSUFFICIENT_FUNDS', title: 'Yetersiz bakiye' } });
        }
      }
      return happyDevice(req, res);
    },
    async (okc, calls, dataDir) => {
      await okc.sellSplit({ saleId: 'p1', key: 'order-1', payment: { type: 'CARD', amount: '4.00' } });
      const declined = await okc.sellSplit({ saleId: 'p2', key: 'order-1', payment: { type: 'CARD', amount: '6.00' } });

      assert.equal(declined.status, 'DECLINED');
      assert.equal(calls.some((call) => call.endsWith('/cancel')), false, 'alınmış kart varken belge iptal edilmez');
      assert.equal(fs.existsSync(splitFile(dataDir)), true);

      const panel = await okc.cancelPending();
      assert.equal(panel.ok, false);
      assert.equal(calls.some((call) => call.endsWith('/cancel')), false);

      // Kalan başka bir kartla tamamlanır.
      const last = await okc.sellSplit({
        saleId: 'p3',
        key: 'order-1',
        payment: { type: 'CARD', amount: '6.00' },
        document: finalDocument,
      });
      assert.equal(last.status, 'APPROVED');
      assert.equal(fs.existsSync(splitFile(dataDir)), false);
    },
  );
});

test('son kart çekildi ama belge kapanmadıysa ret değil belirsizlik; kurtarma kaydı durur', { skip: !tls }, async () => {
  await withDevice(
    (req, res) => {
      if (req.method === 'PUT') {
        return json(res, 400, { status: 'ERROR', error: { code: 'ERR_INVALID_PRM', title: 'Hatalı belge' } });
      }
      return happyDevice(req, res);
    },
    async (okc, _calls, dataDir) => {
      const last = await okc.sellSplit({
        saleId: 'p1',
        key: 'order-1',
        payment: { type: 'CARD', amount: '10.00' },
        document: finalDocument,
      });
      assert.equal(last.status, 'UNKNOWN');
      assert.match(last.error, /Ödeme alındı/);
      assert.equal(fs.existsSync(path.join(dataDir, 'okc-pending.json')), true);
      assert.equal(fs.existsSync(splitFile(dataDir)), true);
    },
  );
});
