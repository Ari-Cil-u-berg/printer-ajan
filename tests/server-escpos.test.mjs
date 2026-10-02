/**
 * Server tickets on printers whose Turkish table is not the server's `ESC t 91`.
 *
 * `fixtures/api-escpos.json` is REAL output of the backend's `renderEscPos`
 * (apps/api/src/printing/escpos.builder.ts): a kitchen ticket, a cash bill with
 * a logo whose pixels are deliberately ESC / GS / 0xFD bytes, the drawer kick
 * and the backend's test page. Regenerate it if that builder's command set
 * changes — the retargeting refuses anything it does not recognise.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import iconv from 'iconv-lite';
import { PrintEngine } from '../dist/main/print/engine.js';
import { retargetServerEscpos, serverTicketBytes } from '../dist/main/print/server-escpos.js';
import { TEXT_TABLES } from '../dist/shared/types.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/api-escpos.json', import.meta.url), 'utf8'));
const bytes = (name) => Buffer.from(fx[name], 'base64');
const PC857 = TEXT_TABLES.PC857_13;
const printer = { target: { kind: 'network', host: '1.2.3.4', port: 9100 }, codepage: 'CP857', width: 42, cut: true };
const legacy = Buffer.from([0x1b, 0x40, 0x1b, 0x74, 13]);

test('no textTable: server bytes go out exactly as before (prefix + payload)', () => {
  for (const name of ['kitchen', 'bill', 'drawer', 'testPage']) {
    const payload = bytes(name);
    assert.deepEqual(serverTicketBytes(payload, printer, legacy), Buffer.concat([legacy, payload]), name);
    assert.deepEqual(serverTicketBytes(payload, { ...printer, textTable: 'SERVER' }, legacy), Buffer.concat([legacy, payload]), name);
  }
});

test('PC857 · 13: every ESC t 91 becomes ESC t 13 and the letters are PC857', () => {
  const out = retargetServerEscpos(bytes('kitchen'), PC857);
  assert.ok(out);
  assert.ok(!out.includes(Buffer.from([0x1b, 0x74, 91])));
  assert.ok(out.includes(Buffer.from([0x1b, 0x74, 13])));
  const text = iconv.decode(out, 'cp857');
  for (const word of ['Türk Kahvesi', 'az şekerli', 'Çiğ Köfte Dürüm', 'Ayşe Güngör', 'Bahçe 4']) {
    assert.ok(text.includes(word), word);
  }
});

test('the logo raster passes through byte for byte, even when its pixels look like commands', () => {
  const raster = bytes('raster');
  const out = retargetServerEscpos(bytes('bill'), PC857);
  assert.ok(out);
  const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, 4, 0, 6, 0]);
  const at = out.indexOf(header);
  assert.ok(at >= 0);
  assert.deepEqual(out.subarray(at + header.length, at + header.length + raster.length), raster);
});

test('cash bill keeps its drawer kick and cut, and the text reads right in PC857', () => {
  const out = retargetServerEscpos(bytes('bill'), PC857);
  assert.ok(out.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0x7d])), 'drawer');
  assert.ok(out.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00])), 'cut');
  const text = iconv.decode(out, 'cp857');
  for (const word of ['Kahve Durağı', 'Şefin hâli', 'kampanyası', 'ÖDENEN', 'Ödeme']) assert.ok(text.includes(word), word);
});

test('only text changes: command and raster bytes are identical apart from the table number', () => {
  // Re-encoding in Windows-1254 at table 91 must reproduce the server's bytes exactly.
  for (const name of ['kitchen', 'bill', 'drawer', 'testPage']) {
    const same = retargetServerEscpos(bytes(name), { n: 91, encoding: 'win1254' });
    assert.deepEqual(same, bytes(name), name);
  }
});

test('ASCII folds the letters and selects table 0', () => {
  const out = retargetServerEscpos(bytes('kitchen'), TEXT_TABLES.ASCII);
  assert.ok(out.includes(Buffer.from([0x1b, 0x74, 0])));
  const text = out.toString('latin1');
  assert.ok(text.includes('Turk Kahvesi') && text.includes('az sekerli'));
});

test('anything unrecognised prints as sent: other table, unknown command, truncated', () => {
  const tl = Buffer.from([0x1b, 0x40, 0x1b, 0x74, 91, 0xfe, 0x0a]);
  assert.equal(retargetServerEscpos(Buffer.from([0x1b, 0x74, 48, 0xfe]), PC857), null);
  assert.equal(retargetServerEscpos(Buffer.concat([tl, Buffer.from([0x1b, 0x2a, 0, 1, 0, 0xff])]), PC857), null);
  assert.equal(retargetServerEscpos(Buffer.concat([tl, Buffer.from([0x1d, 0x76, 0x30, 0, 4, 0, 6, 0, 1, 2])]), PC857), null);
  assert.equal(retargetServerEscpos(Buffer.concat([tl, Buffer.from([0x09])]), PC857), null);
  const fallback = serverTicketBytes(Buffer.from([0x1b, 0x74, 48, 0xfe]), { ...printer, textTable: 'PC857_13' }, legacy);
  assert.deepEqual(fallback, Buffer.concat([legacy, Buffer.from([0x1b, 0x74, 48, 0xfe])]));
});

test('engine: a job with a server-chosen codepage keeps the old prefix path', () => {
  const engine = new PrintEngine(() => ({ printer: { ...printer, textTable: 'PC857_13' }, label: 'x' }));
  const out = engine['renderJob']({ jobId: 'j', station: 'BAR', copies: 1, escpos: fx.kitchen, codepage: 'CP857' }, { ...printer, textTable: 'PC857_13' });
  assert.deepEqual(out, Buffer.concat([legacy, bytes('kitchen')]));
});

test('engine: textTable retargets real tickets', () => {
  const p = { ...printer, textTable: 'PC857_13' };
  const engine = new PrintEngine(() => ({ printer: p, label: 'x' }));
  const out = engine['renderJob']({ jobId: 'j', station: 'KITCHEN', copies: 1, escpos: fx.kitchen }, p);
  assert.deepEqual([...out.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 13]);
  assert.ok(iconv.decode(out, 'cp857').includes('Türk Kahvesi'));
});
