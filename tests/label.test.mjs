/**
 * Etiket (sticker) yazıcısı (23.11.2026): doğrulama, HTML kaçışlama, nokta ölçüsü, 1 bitlik resim,
 * dört dilin baytları ve motorun etiket yolu. Electron'suz: çizici sahte, yazıcı sahte TCP:9100.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { isPrintJob } from '../dist/main/connection.js';
import { PrintEngine } from '../dist/main/print/engine.js';
import { encodeEpl, encodeEscPos, encodeLabel, encodeTspl, encodeZpl, toMono } from '../dist/main/print/label/encode.js';
import { escapeHtml, labelHtml, qrPath, qrSideMm, QR_QUIET } from '../dist/main/print/label/html.js';
import { isLabelJob, labelDots } from '../dist/main/print/label/validate.js';

const QR21 = Array.from({ length: 21 }, (_, y) => (y % 2 ? '1'.repeat(21) : '0'.repeat(21)));

function label(over = {}) {
  return {
    language: 'TSPL',
    widthMm: 50,
    heightMm: 30,
    gapMm: 2,
    dpi: 203,
    elements: [
      { type: 'text', text: 'Mutlu Çocuk Kafe', size: 'M', bold: true, align: 'center' },
      { type: 'text', text: 'No 12 · 14:05', size: 'XL' },
      { type: 'line' },
      { type: 'qr', rows: QR21 },
    ],
    ...over,
  };
}

test('isLabelJob: izin listesi — dil, ölçü, öğe türü, QR, logo', () => {
  assert.equal(isLabelJob(label()), true);
  assert.equal(isLabelJob(label({ language: 'DRIVER', dpi: 300, rotate: 180, invert: true })), true);
  assert.equal(isLabelJob(label({ elements: [{ type: 'logo', src: 'data:image/png;base64,iVBORw0KGgo=' }] })), true);

  assert.equal(isLabelJob(label({ language: 'CPCL' })), false);
  assert.equal(isLabelJob(label({ widthMm: 5 })), false);
  assert.equal(isLabelJob(label({ heightMm: 500 })), false);
  assert.equal(isLabelJob(label({ gapMm: -1 })), false);
  assert.equal(isLabelJob(label({ dpi: 600 })), false);
  assert.equal(isLabelJob(label({ rotate: 90 })), false);
  assert.equal(isLabelJob(label({ extra: 1 })), false, 'bilinmeyen alan');
  assert.equal(isLabelJob(label({ elements: [] })), false);
  assert.equal(isLabelJob(label({ elements: Array.from({ length: 13 }, () => ({ type: 'line' })) })), false);
  assert.equal(isLabelJob(label({ elements: [{ type: 'text', text: 'x'.repeat(121), size: 'M' }] })), false);
  assert.equal(isLabelJob(label({ elements: [{ type: 'text', text: 'a', size: 'XXL' }] })), false);
  assert.equal(isLabelJob(label({ elements: [{ type: 'text', text: 'a', size: 'M', style: 'color:red' }] })), false);
  assert.equal(isLabelJob(label({ elements: [{ type: 'html', text: '<b>x</b>' }] })), false);
  assert.equal(isLabelJob(label({ elements: [{ type: 'qr', rows: ['012'] }] })), false);
  assert.equal(isLabelJob(label({ elements: [{ type: 'qr', rows: QR21.map((r, i) => (i === 3 ? `${r}1` : r)) }] })), false, 'kare değil');
  // Logo yalnız PNG veri adresi: dış adres, SVG (betik taşıyabilir), bozuk base64 reddedilir.
  for (const src of ['https://evil.example/x.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,<script>', 'file:///etc/passwd']) {
    assert.equal(isLabelJob(label({ elements: [{ type: 'logo', src }] })), false, src);
  }
});

test('isPrintJob: etiket işi kabul; etiket + fiş karışık iş ret', () => {
  assert.equal(isPrintJob({ jobId: 'l1', station: 'CASHIER', copies: 2, label: label() }), true);
  assert.equal(isPrintJob({ jobId: 'l2', station: 'CASHIER', copies: 1, label: label({ language: 'X' }) }), false);
  assert.equal(isPrintJob({ jobId: 'l3', station: 'CASHIER', copies: 1, label: label(), escpos: 'AAAA' }), false);
});

test('labelHtml: metin kaçışlanır, CSP ağı kapatır, sayfa etiket ölçüsünde', () => {
  const html = labelHtml(label({ elements: [{ type: 'text', text: '<script>alert(1)</script> "x" & \'y\'', size: 'S' }] }));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;x&quot; &amp; &#39;y&#39;'));
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"/);
  assert.match(html, /@page\{size:50mm 30mm;margin:0\}/);
  assert.equal(escapeHtml('a<b>c'), 'a&lt;b&gt;c');
  assert.match(labelHtml(label({ rotate: 180 })), /transform:rotate\(180deg\)/);
});

test('qrPath: yan yana siyah modüller tek dikdörtgen', () => {
  assert.equal(qrPath(['0110', '1001']), 'M1 0h2v1h-2zM0 1h1v1h-1zM3 1h1v1h-1z');
});

test('QR: modül başına tam sayı nokta (en az 2, sığarsa), sessiz bölge 4 modül (CodeRabbit #14)', () => {
  const job = { widthMm: 50, heightMm: 30, dpi: 203 };
  const perModule = (n, side, dpi = 203) => Math.round(((side / 25.4) * dpi) / (n + QR_QUIET * 2));
  // 21 modül: yarım kenar (15 mm ≈ 119 nokta) 29 modüle 4 nokta verir.
  assert.equal(perModule(21, qrSideMm(21, job)), 4);
  // 69 modül (300 karakterlik içerik): yarım kenarda 1 nokta düşerdi → kenar büyür, 2 nokta.
  assert.equal(perModule(69, qrSideMm(69, job)), 2);
  assert.ok(qrSideMm(69, job) <= 30 - 3, 'etiketin kullanılabilir kısa kenarını aşmaz');
  // 177 modül 30 mm'ye 2 noktayla sığmaz: sığan en büyük (1 nokta).
  assert.equal(perModule(177, qrSideMm(177, job)), 1);
  // 300 dpi'de aynı etiket daha çok nokta verir.
  assert.ok(perModule(69, qrSideMm(69, { ...job, dpi: 300 }), 300) >= 2);
  const html = labelHtml(label({ elements: [{ type: 'qr', rows: QR21 }] }));
  assert.match(html, /viewBox="-4 -4 29 29"/);
});

test('labelDots: mm → nokta, genişlik 8in katına', () => {
  assert.deepEqual(labelDots({ widthMm: 50, heightMm: 30, dpi: 203 }), { width: 400, height: 240 });
  assert.deepEqual(labelDots({ widthMm: 58, heightMm: 40, dpi: 300 }), { width: 688, height: 472 });
});

/** BGRA resim: `black` listesindeki (x,y) siyah, gerisi beyaz; `clear` saydam. */
function bgra(width, height, black, clear = []) {
  const buf = Buffer.alloc(width * height * 4, 0xff);
  for (const [x, y] of black) buf.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  for (const [x, y] of clear) buf.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 4);
  return buf;
}

test('toMono: koyu piksel 1, beyaz ve saydam 0; satır bayta tamamlanır', () => {
  const bmp = toMono(bgra(10, 2, [[0, 0], [9, 0], [1, 1]], [[2, 1]]), 10, 2);
  assert.equal(bmp.bytesPerRow, 2);
  assert.deepEqual([...bmp.data], [0b10000000, 0b01000000, 0b01000000, 0]);
  assert.throws(() => toMono(Buffer.alloc(4), 10, 2));
});

const ONE_DOT = { width: 8, height: 1, bytesPerRow: 1, data: Buffer.from([0b10000000]) };

test('TSPL: SIZE/GAP/CLS/BITMAP/PRINT; 0 = siyah (TSC kılavuzu); invert çevirir', () => {
  const out = encodeTspl(label(), ONE_DOT);
  const text = out.toString('latin1');
  assert.ok(text.startsWith('SIZE 50 mm,30 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 0,0\r\nREFERENCE 0,0\r\nCLS\r\nBITMAP 0,0,1,1,0,'));
  assert.ok(text.endsWith('\r\nPRINT 1,1\r\n'));
  const at = out.indexOf('BITMAP 0,0,1,1,0,') + 'BITMAP 0,0,1,1,0,'.length;
  assert.equal(out[at], 0b01111111, 'siyah nokta 0 biti');
  const inv = encodeTspl(label({ invert: true }), ONE_DOT);
  assert.equal(inv[at], 0b10000000);
  assert.ok(!out.includes(Buffer.from([0x1b, 0x40])), 'ESC @ yok');
});

test('ZPL: ^GFA hex, 1 = siyah', () => {
  const text = encodeZpl(label({ language: 'ZPL' }), ONE_DOT).toString('ascii');
  assert.equal(text, '^XA^PW8^LL1^LH0,0^FO0,0^GFA,1,1,1,80^FS^PQ1^XZ\r\n');
});

test('EPL: N/q/Q/GW/P, boşluk nokta cinsinden; 0 = siyah', () => {
  const out = encodeEpl(label({ language: 'EPL' }), ONE_DOT);
  const text = out.toString('latin1');
  assert.ok(text.startsWith('\r\nN\r\nq8\r\nQ1,16\r\nGW0,0,1,1,'));
  assert.ok(text.endsWith('\r\nP1\r\n'));
  assert.equal(out[out.indexOf('GW0,0,1,1,') + 'GW0,0,1,1,'.length], 0b01111111);
});

test('ESC/POS: GS v 0 + boşlukta GS FF, sürekli rulda ESC d 3', () => {
  const gap = encodeEscPos(label({ language: 'ESCPOS' }), ONE_DOT);
  assert.deepEqual([...gap], [0x1b, 0x40, 0x1d, 0x76, 0x30, 0x00, 1, 0, 1, 0, 0b10000000, 0x1d, 0x0c]);
  const roll = encodeEscPos(label({ language: 'ESCPOS', gapMm: 0 }), ONE_DOT);
  assert.deepEqual([...roll.subarray(-3)], [0x1b, 0x64, 0x03]);
  assert.throws(() => encodeLabel(label({ language: 'DRIVER' }), ONE_DOT));
});

async function fakePrinter() {
  const received = [];
  const server = net.createServer((socket) => {
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => received.push(Buffer.concat(chunks)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { received, port: server.address().port, stop: () => new Promise((r) => server.close(r)) };
}

const waitFor = (fn, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (fn() ? resolve() : Date.now() - t0 > ms ? reject(new Error('timeout')) : setTimeout(tick, 10));
    tick();
  });

function fakeRenderer() {
  const calls = { bitmap: 0, driver: [] };
  return {
    calls,
    bitmap: async (job) => {
      calls.bitmap += 1;
      const { width, height } = labelDots(job);
      return { width, height, bgra: bgra(width, height, [[0, 0]]) };
    },
    printViaDriver: async (job, deviceName) => {
      calls.driver.push([job.language, deviceName]);
    },
  };
}

test('motor: ham dil — tek çizim, kopya kadar gönderim, ESC/POS öneki YOK', async () => {
  const printer = await fakePrinter();
  const renderer = fakeRenderer();
  try {
    const engine = new PrintEngine(
      () => ({ printer: { target: { kind: 'network', host: '127.0.0.1', port: printer.port }, codepage: 'CP857', width: 42, cut: true }, label: 'Etiket' }),
      renderer,
    );
    await engine.print({ jobId: 'l1', station: 'CASHIER', copies: 2, label: label() });
    await waitFor(() => printer.received.length === 2);
    assert.equal(renderer.calls.bitmap, 1);
    for (const bytes of printer.received) {
      assert.ok(bytes.toString('latin1').startsWith('SIZE 50 mm,30 mm'), 'ilk bayt TSPL');
      assert.ok(bytes.toString('latin1').includes('BITMAP 0,0,50,240,0,'));
    }
  } finally {
    await printer.stop();
  }
});

test('motor: sürücü yolu yalnız kurulu yazıcıya; ağ adresinde kalıcı hata', async () => {
  const renderer = fakeRenderer();
  const spooler = new PrintEngine(
    () => ({ printer: { target: { kind: 'spooler', printerName: 'Zebra_ZD220' }, codepage: 'CP857', width: 42, cut: false }, label: 'Etiket' }),
    renderer,
  );
  await spooler.print({ jobId: 'l2', station: 'CASHIER', copies: 3, label: label({ language: 'DRIVER' }) });
  assert.deepEqual(renderer.calls.driver, [['DRIVER', 'Zebra_ZD220'], ['DRIVER', 'Zebra_ZD220'], ['DRIVER', 'Zebra_ZD220']]);

  const network = new PrintEngine(
    () => ({ printer: { target: { kind: 'network', host: '127.0.0.1', port: 9 }, codepage: 'CP857', width: 42, cut: false }, label: 'Etiket' }),
    renderer,
  );
  const permanent = (err) => err.retryable === false;
  await assert.rejects(network.print({ jobId: 'l3', station: 'CASHIER', copies: 1, label: label({ language: 'DRIVER' }) }), permanent);
  // Çizicisi olmayan motor (eski kurulum yolu) etiketi kalıcı hatayla düşürür.
  const bare = new PrintEngine(() => ({ printer: { target: { kind: 'spooler', printerName: 'x' }, codepage: 'CP857', width: 42, cut: false }, label: 'Etiket' }));
  await assert.rejects(bare.print({ jobId: 'l4', station: 'CASHIER', copies: 1, label: label() }), permanent);
});
