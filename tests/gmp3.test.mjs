/**
 * T300 (GMP-3) yolu — belge çevirisi, cevap ayrıştırma, satış akışı ve
 * yardımcı program taşıması.
 *
 * Gerçek cihaz yok: `fakeDevice` Hugin wiki'sindeki durum kodlarıyla ilerleyen
 * bir durum makinesi (IDLE → PAYMENT → OPEN_SALE → IDLE). Testlerin çoğu
 * "hangi çağrı yapıldı" sorusunu soruyor: para yolunda doğru sonuç kadar,
 * YAPILMAMASI gereken çağrının yapılmaması da önemli (ret sonrası ikinci kart,
 * ödemesi alınmış belgenin iptali).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { planGmp3Sale, Gmp3DocumentError } from '../dist/main/okc/gmp3-document.js';
import { amountToMinor, parseResponse, receiptNoOf } from '../dist/main/okc/gmp3-protocol.js';
import { Gmp3Helper } from '../dist/main/okc/gmp3-helper.js';
import { Gmp3OkcManager } from '../dist/main/okc/okc-gmp3.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Cihazın kısım tablosu: 1 → %10, 2 → %20, 3 → %1. */
const DEPARTMENTS = [
  { deptId: 1, vatRate: 10 },
  { deptId: 2, vatRate: 20 },
  { deptId: 3, vatRate: 1 },
];

const item = (overrides = {}) => ({
  name: 'Adana Kebap',
  amount: '300.00',
  quantity: '2',
  unitPrice: '150.00',
  vatRate: 10,
  departmentId: 1,
  ...overrides,
});

const saleDoc = (payments, items = [item()], extra = {}) => ({ items, payments, ...extra });

// --- cevap ayrıştırma ------------------------------------------------------

test('cevap konumsal ayrışır — boş alan sonrakileri kaydırmaz', () => {
  const r = parseResponse('0|1||12|3');
  assert.equal(r.error, 0);
  assert.equal(r.status, 1);
  assert.deepEqual(r.params, ['', '12', '3']);
  assert.equal(parseResponse('abc|1'), null);
  assert.equal(parseResponse(''), null);
});

test('tutar iki ayraçla da okunur, belirsiz metin reddedilir', () => {
  assert.equal(amountToMinor('125,50'), 12550);
  assert.equal(amountToMinor('125.5'), 12550);
  assert.equal(amountToMinor('-10.02'), -1002);
  assert.equal(amountToMinor('1.234,50'), null);
  assert.equal(amountToMinor('12.345'), null);
  assert.equal(receiptNoOf(12, 34), '0012_0034');
});

// --- belge çevirisi --------------------------------------------------------

test('nakit satış: belge JSON içinde kapanır, kısım KDV tablosundan', () => {
  const plan = planGmp3Sale(saleDoc([{ type: 'CASH', amount: '300.00' }]), DEPARTMENTS);
  assert.equal(plan.cardAmountMinor, null);
  assert.equal(plan.totalMinor, 30000);
  assert.deepEqual(plan.document.FiscalItems[0], {
    Id: 0,
    Quantity: 2,
    Price: 150,
    Name: 'Adana Kebap',
    DeptId: 1,
    Status: 0,
    Adj: null,
  });
  assert.deepEqual(plan.document.Payments, [{ Type: 0, Index: 0, PaidTotal: 300 }]);
  assert.equal(plan.document.EndOfReceiptInfo.CloseReceiptFlag, true);
});

test('kart satışı: belge açık kalır, kart tutarı ayrı', () => {
  const plan = planGmp3Sale(
    saleDoc([
      { type: 'CASH', amount: '100.00' },
      { type: 'EFT_POS', amount: '200.00' },
    ]),
    DEPARTMENTS,
  );
  assert.equal(plan.cardAmountMinor, 20000);
  assert.deepEqual(plan.document.Payments, [{ Type: 0, Index: 0, PaidTotal: 100 }]);
  assert.equal(plan.document.EndOfReceiptInfo.CloseReceiptFlag, false);
});

test('backend’in önerdiği kısım oranı tutmuyorsa cihazın o oranlı ilk kısmı seçilir', () => {
  // Backend varsayılan kısım 1'i yazdı ama ürün %20: kısım 1 %10'luk.
  const plan = planGmp3Sale(
    saleDoc([{ type: 'CASH', amount: '300.00' }], [item({ vatRate: 20, departmentId: 1 })]),
    DEPARTMENTS,
  );
  assert.equal(plan.document.FiscalItems[0].DeptId, 2);
});

test('cihazda o KDV oranlı kısım yoksa satış durur — yanlış vergiyle fiş kesilmez', () => {
  assert.throws(
    () => planGmp3Sale(saleDoc([{ type: 'CASH', amount: '300.00' }], [item({ vatRate: 8 })]), DEPARTMENTS),
    (err) => err instanceof Gmp3DocumentError && /%8 KDV/.test(err.message),
  );
});

test('birden fazla kart ödemesi reddedilir — eski kart ödemesi ikinci kez çekilmez', () => {
  assert.throws(
    () =>
      planGmp3Sale(
        saleDoc([
          { type: 'EFT_POS', amount: '100.00' },
          { type: 'EFT_POS', amount: '200.00' },
        ]),
        DEPARTMENTS,
      ),
    /birden fazla kart/,
  );
});

test('dengesiz belge ve desteklenmeyen ödeme tipi reddedilir', () => {
  assert.throws(() => planGmp3Sale(saleDoc([{ type: 'CASH', amount: '299.99' }]), DEPARTMENTS), /dengesiz/);
  assert.throws(() => planGmp3Sale(saleDoc([{ type: 'VOUCHER', amount: '300.00' }]), DEPARTMENTS), /desteklenmiyor/);
});

test('indirimler: satır indirimi Adj, belge indirimi tek Adjustment — eksi tutarla', () => {
  const plan = planGmp3Sale(
    saleDoc([{ type: 'CASH', amount: '270.00' }], [item({ discount: { amount: '20.00' } })], {
      totals: { discounts: [{ amount: '10.00' }] },
    }),
    DEPARTMENTS,
  );
  assert.deepEqual(plan.document.FiscalItems[0].Adj, { Type: 2, Amount: -20 });
  assert.deepEqual(plan.document.Adjustments, [{ Type: 2, Amount: -10 }]);
});

test('ürün adı 20 karaktere kesilir (Türkçe harf tek karakter), QR düşer, not 32 karakter', () => {
  const plan = planGmp3Sale(
    saleDoc([{ type: 'CASH', amount: '300.00' }], [item({ name: 'Şiş Köfte Porsiyon Büyük Acılı' })], {
      footerNotes: ['Bizi tercih ettiğiniz için teşekkür ederiz, yine bekleriz', 'QRTabc-123'],
    }),
    DEPARTMENTS,
  );
  assert.equal(plan.document.FiscalItems[0].Name, 'Şiş Köfte Porsiyon B');
  assert.equal(Array.from(plan.document.FiscalItems[0].Name).length, 20);
  assert.deepEqual(plan.document.FooterNotes, ['Bizi tercih ettiğiniz için teşek']);
  assert.equal(plan.droppedQr, true);
});

test('birim fiyat × adet satır tutarını tutmuyorsa durur', () => {
  assert.throws(
    () => planGmp3Sale(saleDoc([{ type: 'CASH', amount: '300.00' }], [item({ unitPrice: '149.99' })]), DEPARTMENTS),
    /tutmuyor/,
  );
});

// --- satış akışı (sahte cihaz) --------------------------------------------

const ok = (raw) => ({ ok: true, raw });

/**
 * Hugin durum kodlarıyla ilerleyen sahte T300. `overrides[cmd]` bir cevap
 * dönerse o kullanılır; `undefined` dönerse varsayılan davranış.
 */
function fakeDevice(overrides = {}) {
  const calls = [];
  const dev = {
    status: 1,
    docNo: 33,
    zNo: 12,
    vat: ['10', '20', '1', '0', '0', '0', '0', '0'],
    depts: { 1: ['YIYECEK', '0'], 2: ['ALKOL', '1'], 3: ['TEMEL', '2'] },
    documents: [],
  };
  const transport = {
    async request(cmd, args) {
      calls.push(cmd);
      const custom = overrides[cmd]?.(args, dev, calls);
      if (custom !== undefined) return custom;
      switch (cmd) {
        case 'connect':
          return { ok: true, library: '4.64' };
        case 'status':
          return ok(`0|${dev.status}|30.10.2026|12:00`);
        case 'lastDocument':
          return ok(`0|${dev.status}|${dev.docNo}|${dev.zNo}|1|1|30.10.2026|12:00`);
        case 'vatRate':
          return ok(`0|1|${dev.vat[args.index]}`);
        case 'department': {
          const dept = dev.depts[args.deptId];
          return dept ? ok(`0|1|${dept[0]}|${dept[1]}|0|0|0`) : ok('113|1');
        }
        case 'printDeptOnly':
          dev.documents.push(args.document);
          if (args.document.EndOfReceiptInfo.CloseReceiptFlag) {
            dev.docNo += 1;
            dev.status = 1;
          } else {
            dev.status = 4;
          }
          return ok(`0|${dev.status}`);
        case 'eft':
          dev.status = 5;
          return ok(`0|5|${args.amount}|778899|${args.amount}|0|062|454360|062|1|5|17|${args.amount}`);
        case 'closeReceipt':
        case 'voidReceipt':
          dev.docNo += 1;
          dev.status = 1;
          return ok(`0|1|${dev.docNo}`);
        case 'dailySummary':
          return ok(
            JSON.stringify({
              summaries: [{ DocumentType: 1, ValidAmount: 150.5, VatTotal: 13.68, Cash: 50, Credit: 100.5 }],
            }),
          );
        case 'zReport':
          dev.zNo += 1;
          return ok(`0|1|${dev.docNo + 1}|${dev.zNo}`);
        case 'version':
          return ok('0|1|T300');
        default:
          return { ok: false, kind: 'usage', error: 'Bilinmeyen komut' };
      }
    },
    close() {
      calls.push('close');
    },
  };
  return { transport, calls, dev };
}

function manager(transport) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp3-'));
  const okc = new Gmp3OkcManager(
    dataDir,
    { protocol: 'gmp3', host: '192.168.1.60', port: 4444, serialNo: 'FT40012345' },
    () => {},
    transport,
  );
  return { okc, pendingFile: path.join(dataDir, 'okc-gmp3-pending.json') };
}

const moneyCalls = (calls) => calls.filter((c) => ['printDeptOnly', 'eft', 'closeReceipt', 'voidReceipt'].includes(c));

test('nakit satış onaylanır, fiş numarası ZZZZ_NNNN, kayıt kalmaz', async () => {
  const { transport, calls } = fakeDevice();
  const { okc, pendingFile } = manager(transport);
  const result = await okc.sell({ saleId: 's1', document: saleDoc([{ type: 'CASH', amount: '300.00' }]) });
  assert.equal(result.status, 'APPROVED');
  assert.equal(result.receiptNo, '0012_0034');
  assert.deepEqual(moneyCalls(calls), ['printDeptOnly']);
  assert.equal(fs.existsSync(pendingFile), false);
});

test('kart satışı: kalemler → kart → kapat', async () => {
  const { transport, calls, dev } = fakeDevice();
  const { okc, pendingFile } = manager(transport);
  const result = await okc.sell({ saleId: 's2', document: saleDoc([{ type: 'EFT_POS', amount: '300.00' }]) });
  assert.equal(result.status, 'APPROVED');
  assert.equal(result.receiptNo, '0012_0034');
  assert.deepEqual(moneyCalls(calls), ['printDeptOnly', 'eft', 'closeReceipt']);
  assert.equal(dev.documents[0].EndOfReceiptInfo.CloseReceiptFlag, false);
  assert.equal(fs.existsSync(pendingFile), false);
});

test('kart reddi: belge iptal edilir, ikinci kart denenmez, kayıt kalmaz', async () => {
  const { transport, calls } = fakeDevice({ eft: () => ok('174|4') });
  const { okc, pendingFile } = manager(transport);
  const result = await okc.sell({ saleId: 's3', document: saleDoc([{ type: 'EFT_POS', amount: '300.00' }]) });
  assert.equal(result.status, 'DECLINED');
  assert.equal(result.code, 'GMP3_174');
  assert.match(result.error, /provizyon/);
  assert.deepEqual(moneyCalls(calls), ['printDeptOnly', 'eft', 'voidReceipt']);
  assert.equal(fs.existsSync(pendingFile), false);
});

test('kart cevabı kaybolursa BİLMİYORUM — belge iptal edilmez, kayıt kalır; tekrar dene kapatır', async () => {
  let lost = true;
  const { transport, calls, dev } = fakeDevice({
    eft: (_args, device) => {
      if (!lost) return undefined;
      lost = false;
      device.status = 5; // kart cihazda ÇEKİLDİ, cevap yolda kayboldu
      return { ok: false, kind: 'timeout', error: 'Yazarkasa cevap vermedi' };
    },
  });
  const { okc, pendingFile } = manager(transport);
  const result = await okc.sell({ saleId: 's4', document: saleDoc([{ type: 'EFT_POS', amount: '300.00' }]) });
  assert.equal(result.status, 'UNKNOWN');
  assert.ok(!calls.includes('voidReceipt'), 'parası çekilmiş olabilecek belge iptal edilmemeli');
  assert.ok(fs.existsSync(pendingFile));

  const retry = await okc.retryPending();
  assert.equal(retry.status, 'APPROVED');
  assert.equal(retry.saleId, 's4');
  assert.equal(calls.filter((c) => c === 'eft').length, 1, 'ödemesi tamam belgede kart yeniden istenmez');
  assert.equal(dev.status, 1);
  assert.equal(fs.existsSync(pendingFile), false);
});

test('kart alındı ama fiş kapanmadı (kağıt) → BİLMİYORUM, tekrar dene kapatır', async () => {
  let paper = false;
  const { transport } = fakeDevice({ closeReceipt: () => (paper ? undefined : ok('8|5')) });
  const { okc, pendingFile } = manager(transport);
  const result = await okc.sell({ saleId: 's5', document: saleDoc([{ type: 'EFT_POS', amount: '300.00' }]) });
  assert.equal(result.status, 'UNKNOWN');
  assert.match(result.error, /Ödeme alındı/);
  assert.ok(fs.existsSync(pendingFile));

  paper = true;
  const retry = await okc.retryPending();
  assert.equal(retry.status, 'APPROVED');
  assert.equal(fs.existsSync(pendingFile), false);
});

test('bağlanılamıyorsa satış cihaza hiç gitmez — ret, kayıt yok', async () => {
  const { transport, calls } = fakeDevice({
    connect: () => ({ ok: false, kind: 'transport', error: 'Yazarkasaya bağlanılamadı (TimedOut)' }),
  });
  const { okc, pendingFile } = manager(transport);
  const result = await okc.sell({ saleId: 's6', document: saleDoc([{ type: 'CASH', amount: '300.00' }]) });
  assert.equal(result.status, 'DECLINED');
  assert.deepEqual(moneyCalls(calls), []);
  // Kapalı cihazda tek bağlanma denemesi — on altı tablo okumasının her biri değil.
  assert.equal(calls.filter((c) => c === 'connect').length, 1);
  assert.equal(fs.existsSync(pendingFile), false);
});

test('kalemler gönderilirken bağlantı yoksa (gitmedi) ret ve kayıt temizlenir', async () => {
  let drops = 0;
  const { transport, calls } = fakeDevice({
    printDeptOnly: () => ({ ok: false, kind: 'not_connected', error: 'Yazarkasaya bağlı değil' }),
    connect: () => (drops++ > 0 ? { ok: false, kind: 'transport', error: 'bağlanılamadı' } : undefined),
  });
  const { okc, pendingFile } = manager(transport);
  const result = await okc.sell({ saleId: 's7', document: saleDoc([{ type: 'CASH', amount: '300.00' }]) });
  assert.equal(result.status, 'DECLINED');
  assert.ok(!calls.includes('voidReceipt'));
  assert.equal(fs.existsSync(pendingFile), false);
});

test('cihazda açık belge varken yeni satış başlamaz', async () => {
  const { transport, calls, dev } = fakeDevice();
  dev.status = 4;
  const { okc } = manager(transport);
  const result = await okc.sell({ saleId: 's8', document: saleDoc([{ type: 'CASH', amount: '300.00' }]) });
  assert.equal(result.status, 'DECLINED');
  assert.match(result.error, /hazır değil/);
  assert.deepEqual(moneyCalls(calls), []);
});

test('KDV kısmı tanımsızsa belge cihaza gitmeden ret', async () => {
  const { transport, calls } = fakeDevice();
  const { okc } = manager(transport);
  const result = await okc.sell({
    saleId: 's9',
    document: saleDoc([{ type: 'CASH', amount: '300.00' }], [item({ vatRate: 8 })]),
  });
  assert.equal(result.status, 'DECLINED');
  assert.deepEqual(moneyCalls(calls), []);
});

test('ödemesi alınmış belge iptal edilmez; ödemesi alınmamış iptal edilir', async () => {
  const { transport, calls, dev } = fakeDevice();
  const { okc } = manager(transport);

  dev.status = 5;
  const paid = await okc.cancelPending();
  assert.equal(paid.ok, false);
  assert.match(paid.error, /Tekrar dene/);
  assert.ok(!calls.includes('voidReceipt'));

  dev.status = 4;
  const unpaid = await okc.cancelPending();
  assert.equal(unpaid.ok, true);
  assert.ok(calls.includes('voidReceipt'));
});

test('kart beklenirken kasadan iptal reddedilir — iptal cihazın ekranından', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { transport } = fakeDevice({
    eft: (args, dev) =>
      gate.then(() => {
        dev.status = 5;
        return ok(`0|5|${args.amount}|1|${args.amount}|0|062|454360|062|1|5|17|${args.amount}`);
      }),
  });
  const { okc } = manager(transport);
  const sale = okc.sell({ saleId: 's10', document: saleDoc([{ type: 'EFT_POS', amount: '300.00' }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancel = await okc.cancelSale('s10');
  assert.equal(cancel.ok, false);
  assert.match(cancel.error, /yazarkasanın ekranından/);
  const busy = await okc.sell({ saleId: 's11', document: saleDoc([{ type: 'CASH', amount: '300.00' }]) });
  assert.equal(busy.status, 'DECLINED');
  assert.match(busy.error, /meşgul/);
  release();
  assert.equal((await sale).status, 'APPROVED');
});

test('gün sonu: özet Z’den önce okunur, rapor backend’in alan adlarıyla', async () => {
  const { transport, calls } = fakeDevice();
  const { okc } = manager(transport);
  const z = await okc.dailyZ();
  assert.equal(z.ok, true);
  assert.equal(z.serialNo, 'FT40012345');
  assert.ok(calls.indexOf('dailySummary') < calls.indexOf('zReport'));
  assert.equal(z.report.reportHeader.receiptNo, '0013_0034');
  assert.equal(z.report.grossSales.total, '150.50');
  assert.equal(z.report.topKdv, '13.68');
  assert.equal(z.report.cash.total, '50.00');
  assert.equal(z.report.eftPos.total, '100.50');
});

// --- yardımcı program taşıması (gerçek alt süreç) --------------------------

const fakeHelper = () => new Gmp3Helper(process.execPath, [path.join(here, 'fixtures', 'gmp3-fake-helper.mjs')]);

test('istekler sırayla gider, her cevap kendi isteğine', async () => {
  const helper = fakeHelper();
  try {
    const [slow, fast] = await Promise.all([
      helper.request('slow', {}, 5000),
      helper.request('status', {}, 5000),
    ]);
    assert.equal(slow.raw, '0|1|slow');
    assert.equal(fast.raw, '0|1|status');
  } finally {
    helper.close();
  }
});

test('cevapsız istek zaman aşımına düşer (belirsiz) ve süreç yenilenir', async () => {
  const helper = fakeHelper();
  try {
    const hung = await helper.request('hang', {}, 300);
    assert.equal(hung.ok, false);
    assert.equal(hung.kind, 'timeout');
    const next = await helper.request('status', {}, 5000);
    assert.equal(next.raw, '0|1|status');
  } finally {
    helper.close();
  }
});

test('süreç çökerse bekleyen istek "exited" döner, sonraki istek çalışır', async () => {
  const helper = fakeHelper();
  try {
    const crashed = await helper.request('crash', {}, 5000);
    assert.equal(crashed.kind, 'exited');
    const next = await helper.request('status', {}, 5000);
    assert.equal(next.raw, '0|1|status');
  } finally {
    helper.close();
  }
});

test('yardımcı program yoksa istek cihaza gitmemiş sayılır', async () => {
  const helper = new Gmp3Helper(path.join(here, 'yok', 'AriHuginFpu.exe'));
  const reply = await helper.request('status', {}, 1000);
  assert.equal(reply.ok, false);
  assert.equal(reply.kind, 'usage');
});
