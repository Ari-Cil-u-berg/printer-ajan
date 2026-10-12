/**
 * D1–D3 (Chinese mode off) and E (tickets as images) — for printers where none
 * of A–C prints the Turkish letters (Sunlux, Xprinter). Same real backend
 * output as server-escpos.test.mjs; none of this may touch a printer that
 * keeps its old setting (that is server-escpos.test.mjs's job).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import iconv from 'iconv-lite';
import { paperDots, rasterTextLines } from '../dist/main/print/raster-ticket.js';
import { calibrationBlock, retargetServerEscpos, serverTicketBytes } from '../dist/main/print/server-escpos.js';
import { isTextTableSetting, TEXT_TABLES } from '../dist/shared/types.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/api-escpos.json', import.meta.url), 'utf8'));
const bytes = (name) => Buffer.from(fx[name], 'base64');
const printer = { target: { kind: 'network', host: '1.2.3.4', port: 9100 }, codepage: 'CP857', width: 42, cut: true };
const legacy = Buffer.from([0x1b, 0x40, 0x1b, 0x74, 13]);
const TICKETS = ['kitchen', 'bill', 'drawer', 'testPage'];

/** Walks raster-mode output; throws on anything but what E is allowed to send. */
function walk(out) {
  const images = [];
  const commands = [];
  let i = 0;
  while (i < out.length) {
    const b = out[i];
    const op = out[i + 1];
    if (b === 0x1d && op === 0x76) {
      const wb = out[i + 4] | (out[i + 5] << 8);
      const h = out[i + 6] | (out[i + 7] << 8);
      images.push({ wb, h, data: out.subarray(i + 8, i + 8 + wb * h) });
      i += 8 + wb * h;
    } else if (b === 0x0a) {
      commands.push('LF');
      i += 1;
    } else if (b === 0x1b && op === 0x40) {
      commands.push('ESC @');
      i += 2;
    } else if (b === 0x1b && op === 0x64) {
      commands.push('ESC d');
      i += 3;
    } else if (b === 0x1b && op === 0x70) {
      commands.push('ESC p');
      i += 5;
    } else if (b === 0x1d && op === 0x56) {
      commands.push('GS V');
      i += out[i + 2] === 65 || out[i + 2] === 66 ? 4 : 3;
    } else {
      throw new Error(`unexpected byte 0x${b.toString(16)} at ${i}`);
    }
  }
  return { images, commands };
}

test('settings: D1–D3 and E are accepted, anything else is not', () => {
  for (const key of ['FS_WPC1254_91', 'FS_PC857_13', 'FS_WPC1254_48', 'RASTER', 'PC857_13', 'ASCII']) {
    assert.ok(isTextTableSetting(key), key);
  }
  for (const key of ['BOGUS', '', 'raster', '__proto__', 'toString', 42, undefined]) assert.ok(!isTextTableSetting(key), String(key));
});

test('D: FS . follows every ESC @ and the letters are in the chosen table', () => {
  const p = { ...printer, textTable: 'FS_PC857_13' };
  const out = serverTicketBytes(bytes('kitchen'), p, legacy);
  assert.deepEqual([...out.subarray(0, 7)], [0x1b, 0x40, 0x1c, 0x2e, 0x1b, 0x74, 13]);
  for (let i = out.indexOf(Buffer.from([0x1b, 0x40]), 2); i >= 0; i = out.indexOf(Buffer.from([0x1b, 0x40]), i + 2)) {
    assert.deepEqual([...out.subarray(i + 2, i + 4)], [0x1c, 0x2e], `ESC @ at ${i}`);
  }
  assert.ok(iconv.decode(out, 'cp857').includes('Çiğ Köfte Dürüm'));
});

test('D1 (91): the server bytes exactly, plus FS . after each ESC @', () => {
  for (const name of TICKETS) {
    const src = bytes(name);
    const out = retargetServerEscpos(src, TEXT_TABLES.FS_WPC1254_91);
    const withoutFs = Buffer.from(out.toString('latin1').split('\x1b\x40\x1c\x2e').join('\x1b\x40'), 'latin1');
    assert.deepEqual(withoutFs, src, name);
  }
});

test('E: every ticket becomes images plus the printer-side commands only', () => {
  for (const width of [32, 42, 48]) {
    for (const name of TICKETS) {
      const out = serverTicketBytes(bytes(name), { ...printer, width, textTable: 'RASTER' }, legacy);
      const { images } = walk(out);
      for (const img of images) assert.ok(img.wb * 8 <= Math.max(paperDots(width), 576), `${name}@${width}: ${img.wb} bytes wide`);
    }
  }
});

test('E: the logo, the drawer kick and the cut pass through untouched', () => {
  const out = serverTicketBytes(bytes('bill'), { ...printer, textTable: 'RASTER' }, legacy);
  const raster = bytes('raster');
  const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, 4, 0, 6, 0]);
  const at = out.indexOf(header);
  assert.ok(at >= 0, 'logo');
  assert.deepEqual(out.subarray(at + header.length, at + header.length + raster.length), raster);
  // Same order as the server sent them: feed, cut, then the drawer kick.
  const { commands } = walk(out);
  assert.deepEqual(commands.slice(-3), ['ESC d', 'GS V', 'ESC p']);
  assert.deepEqual(out.subarray(-12), bytes('bill').subarray(-12));
});

test('E: Turkish letters are drawn, not substituted', () => {
  const paper = paperDots(42);
  for (const [tr, ascii] of [['ş', 's'], ['ğ', 'g'], ['ı', 'i'], ['İ', 'I'], ['Ç', 'C'], ['ü', 'u']]) {
    const a = rasterTextLines([tr], paper);
    const b = rasterTextLines([ascii], paper);
    assert.notDeepEqual(a, b, tr);
    assert.ok(walk(a).images.length === 1, tr);
  }
  // A line of spaces has no dots: a plain LF, not an empty image.
  assert.deepEqual(rasterTextLines(['   '], paper), Buffer.from([0x0a]));
});

test('E: alignment is drawn into the image — ESC a never reaches the printer', () => {
  const src = Buffer.from([0x1b, 0x40, 0x1b, 0x74, 91, 0x1b, 0x61, 0x01, 0x41, 0x0a]);
  const out = serverTicketBytes(src, { ...printer, textTable: 'RASTER' }, legacy);
  assert.equal(out.indexOf(Buffer.from([0x1b, 0x61])), -1);
  const [img] = walk(out).images;
  // A centred 12-dot "A" on 576 dots starts near dot 282: the first 35 bytes of every row are blank.
  for (let y = 0; y < img.h; y++) assert.ok(img.data.subarray(y * img.wb, y * img.wb + 35).every((v) => v === 0));
});

test('E: anything unrecognised prints as sent', () => {
  const odd = Buffer.from([0x1b, 0x40, 0x1b, 0x74, 91, 0x41, 0x1b, 0x2a, 0, 1, 0, 0xff]);
  assert.deepEqual(serverTicketBytes(odd, { ...printer, textTable: 'RASTER' }, legacy), Buffer.concat([legacy, odd]));
});

test('E: a stream that would balloon into images prints as sent', () => {
  // 600 KB of text at GS ! 8x8 would be gigabytes of pixels.
  const huge = Buffer.concat([Buffer.from([0x1b, 0x40, 0x1b, 0x74, 91, 0x1d, 0x21, 0x77]), Buffer.alloc(600_000, 0x57)]);
  const started = Date.now();
  assert.deepEqual(serverTicketBytes(huge, { ...printer, textTable: 'RASTER' }, legacy), Buffer.concat([legacy, huge]));
  assert.ok(Date.now() - started < 5000, 'gives up early');
});

test('test slip: starts from ESC @, shows D1–D3 with FS . and E as an image', () => {
  const block = calibrationBlock(42, true);
  assert.deepEqual([...block.subarray(0, 2)], [0x1b, 0x40]);
  for (const n of [91, 13, 48]) assert.ok(block.includes(Buffer.from([0x1c, 0x2e, 0x1b, 0x74, n])), `D ${n}`);
  assert.ok(block.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00])), 'E image');
  const text = block.toString('latin1');
  for (const label of ['A) ', 'B) ', 'C) ', 'D1) ', 'D2) ', 'D3) ']) assert.ok(text.includes(label), label);
});
