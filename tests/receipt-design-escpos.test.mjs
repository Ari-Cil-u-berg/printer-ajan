/**
 * Fiş tasarımı (backend, 19.10.2026) added two commands to server tickets:
 * `GS B n` (white on black — the Modern style, a kitchen's highlighted notes)
 * and `ESC - n` (underline — the Zarif style's farewell).
 *
 * The agent did not know them, so every such ticket was "unrecognised" and
 * went out untranslated: wrong Turkish letters on the printers that had picked
 * a Türkçe setting (B–E). `fixtures/design-escpos.json` is REAL output of the
 * backend's `renderEscPos` for those three tickets.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import iconv from 'iconv-lite';
import { retargetServerEscpos, serverTicketBytes, tokenizeServerEscpos } from '../dist/main/print/server-escpos.js';
import { TEXT_TABLES } from '../dist/shared/types.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/design-escpos.json', import.meta.url), 'utf8'));
const bytes = (name) => Buffer.from(fx[name], 'base64');
const printer = { target: { kind: 'network', host: '1.2.3.4', port: 9100 }, codepage: 'CP857', width: 42, cut: true };
const legacy = Buffer.from([0x1b, 0x40, 0x1b, 0x74, 13]);
const INVERT = Buffer.from([0x1d, 0x42]);
const UNDERLINE = Buffer.from([0x1b, 0x2d]);
const DESIGNED = ['billModern', 'billElegant', 'kitchenHighlight'];

/** Raster images in E output, skipping the printer-side commands E may send. */
function images(out) {
  const found = [];
  let i = 0;
  while (i < out.length) {
    const [b, op] = [out[i], out[i + 1]];
    if (b === 0x1d && op === 0x76) {
      const wb = out[i + 4] | (out[i + 5] << 8);
      const h = out[i + 6] | (out[i + 7] << 8);
      found.push({ wb, h, data: out.subarray(i + 8, i + 8 + wb * h) });
      i += 8 + wb * h;
    } else if (b === 0x0a) i += 1;
    else if (b === 0x1b && op === 0x40) i += 2;
    else if (b === 0x1b && op === 0x64) i += 3;
    else if (b === 0x1b && op === 0x70) i += 5;
    else if (b === 0x1d && op === 0x56) i += out[i + 2] === 65 || out[i + 2] === 66 ? 4 : 3;
    else throw new Error(`unexpected byte 0x${b.toString(16)} at ${i}`);
  }
  return found;
}

const inkShare = ({ data }) => {
  let ink = 0;
  for (const byte of data) for (let bit = 0; bit < 8; bit++) if (byte & (0x80 >> bit)) ink += 1;
  return ink / (data.length * 8);
};

test('fixtures carry the new commands (regenerate them if the builder changes)', () => {
  assert.ok(bytes('billModern').includes(INVERT));
  assert.ok(bytes('kitchenHighlight').includes(INVERT));
  assert.ok(bytes('billElegant').includes(UNDERLINE));
});

test('designed tickets are understood, not printed as sent', () => {
  for (const name of DESIGNED) assert.notEqual(tokenizeServerEscpos(bytes(name)), null, name);
});

test('B–D: GS B and ESC - pass through, the letters are re-encoded', () => {
  for (const name of DESIGNED) {
    const out = retargetServerEscpos(bytes(name), TEXT_TABLES.PC857_13);
    assert.notEqual(out, null, name);
    const marker = name === 'billElegant' ? UNDERLINE : INVERT;
    assert.ok(out.includes(marker), `${name} keeps its style command`);
  }
  const kitchen = retargetServerEscpos(bytes('kitchenHighlight'), TEXT_TABLES.PC857_13);
  assert.ok(kitchen.includes(iconv.encode('acısız', 'cp857')), 'highlighted note in PC857');
  assert.ok(kitchen.includes(iconv.encode('İçli Köfte', 'cp857')), 'item in PC857');
});

test('E: designed tickets become images, with no style command left for the printer', () => {
  for (const name of DESIGNED) {
    const out = serverTicketBytes(bytes(name), { ...printer, textTable: 'RASTER' }, legacy);
    assert.notDeepEqual(out, Buffer.concat([legacy, bytes(name)]), `${name} was rasterised`);
    assert.ok(images(out).length > 0, name);
  }
});

test('E: a highlighted note is drawn white on black', () => {
  const plain = Buffer.from(bytes('kitchenHighlight').toString('latin1').split('\x1d\x42\x01').join('\x1d\x42\x00'), 'latin1');
  const withInvert = images(serverTicketBytes(bytes('kitchenHighlight'), { ...printer, textTable: 'RASTER' }, legacy));
  const without = images(serverTicketBytes(plain, { ...printer, textTable: 'RASTER' }, legacy));
  const darkest = (list) => Math.max(...list.map(inkShare));
  assert.ok(darkest(withInvert) > 0.5, 'an inverted line is mostly ink');
  assert.ok(darkest(without) < 0.5, 'the same ticket without GS B is not');
});
