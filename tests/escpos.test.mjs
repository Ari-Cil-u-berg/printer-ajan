import assert from 'node:assert/strict';
import test from 'node:test';
import { EscPosBuilder, encodeText, foldToAscii, renderTestTicket, renderTicket } from '../dist/main/print/escpos.js';

const printer = { target: { kind: 'network', host: '1.2.3.4', port: 9100 }, codepage: 'CP857', width: 42, cut: true };

test('CP857 encodes Turkish letters to single bytes, not "?"', () => {
  const bytes = encodeText('çğışöüÇĞİŞÖÜ', 'CP857');
  assert.equal(bytes.length, 12);
  assert.ok(!bytes.includes(0x3f), 'no unmappable characters');
});

test('ESC t selects code page 13 for CP857', () => {
  const out = new EscPosBuilder('CP857', 42).init().build();
  assert.deepEqual([...out], [0x1b, 0x40, 0x1b, 0x74, 13]);
});

test('ISO-8859-9 selects page 47', () => {
  const out = new EscPosBuilder('ISO8859_9', 42).init().build();
  assert.equal(out[4], 47);
});

test('unknown code page falls back to CP857 rather than throwing', () => {
  const out = new EscPosBuilder('NOPE', 42).init().build();
  assert.equal(out[4], 13);
});

test('unmappable characters fold to ASCII lookalikes instead of "?"', () => {
  assert.equal(foldToAscii('Çilekli Şarap ılık'), 'Cilekli Sarap ilik');
  const bytes = encodeText('日本', 'CP857');
  assert.ok(bytes.length > 0);
});

test('columns pad to the configured width', () => {
  const out = new EscPosBuilder('CP857', 42).columns('Fis No: 12', '10:30').build().toString('latin1');
  const line = out.replace(/\n$/, '');
  assert.equal(line.length, 42);
  assert.ok(line.startsWith('Fis No: 12'));
  assert.ok(line.endsWith('10:30'));
});

test('wrapped() never exceeds the paper width', () => {
  const text = 'Bu cok uzun bir not satiri olup otomatik olarak satirlara bolunmelidir cunku fis dar';
  const out = new EscPosBuilder('CP857', 32).wrapped(text, 4).build().toString('latin1');
  for (const line of out.split('\n').filter(Boolean)) assert.ok(line.length <= 32, line);
});

test('ticket renders header, items, notes and a cut', () => {
  const bytes = renderTicket(
    {
      kind: 'ORDER',
      station: 'KITCHEN',
      orderNo: '104',
      tableName: 'Masa 5',
      waiterName: 'Ayşe',
      createdAt: new Date().toISOString(),
      items: [{ qty: 2, name: 'Türk Kahvesi', note: 'Az şekerli', options: ['Yanında su'] }],
    },
    printer,
  );
  const text = bytes.toString('latin1');
  assert.ok(text.includes('MUTFAK'));
  assert.ok(text.includes('104'));
  assert.ok(text.includes('2 x T'));
  // GS V 66 partial cut
  assert.ok(bytes.includes(Buffer.from([0x1d, 0x56, 66])));
});

test('test ticket contains the Turkish proof line', () => {
  const text = renderTestTicket(printer, 'BAR').toString('latin1');
  assert.ok(text.includes('TEST F'));
  assert.ok(text.includes('CP857'));
});

test('cut:false omits the cut command', () => {
  const bytes = renderTestTicket({ ...printer, cut: false }, 'BAR');
  assert.ok(!bytes.includes(Buffer.from([0x1d, 0x56, 66])));
});
