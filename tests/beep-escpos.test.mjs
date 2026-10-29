/**
 * "Fiş çıkınca öt" (backend, 30.10.2026): kitchen tickets may carry the
 * printer's buzzer command right after `ESC @` + `ESC t 91` — `ESC ( A`
 * (Epson), `ESC B n t` (Xprinter-style) or `BEL` ×n.
 *
 * The agent did not know them, so a ringing ticket was "unrecognised" and went
 * out untranslated: wrong Turkish letters on every printer with an agent
 * Türkçe setting (B, C, D1–D3, F, E). `fixtures/beep-escpos.json` is REAL
 * output of the backend's `renderEscPos` / `renderBeepTest`
 * (apps/api/src/printing/escpos.builder.ts): one kitchen order without a beep
 * and with each kind, a cancellation, and the "Test sesi" payloads.
 * Regenerate it if `beepBytes` changes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import iconv from 'iconv-lite';
import { retargetServerEscpos, serverTicketBytes, tokenizeServerEscpos } from '../dist/main/print/server-escpos.js';
import { TEXT_TABLES } from '../dist/shared/types.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/beep-escpos.json', import.meta.url), 'utf8'));
const bytes = (name) => Buffer.from(fx[name], 'base64');
const printer = { target: { kind: 'network', host: '1.2.3.4', port: 9100 }, codepage: 'CP857', width: 42, cut: true };
const legacy = Buffer.from([0x1b, 0x40, 0x1b, 0x74, 13]);
const SERVER_HEAD = Buffer.from([0x1b, 0x40, 0x1b, 0x74, 91]);

/** What the backend's `beepBytes` writes for each fixture. */
const BEEPS = {
  kitchenEpson: Buffer.from([0x1b, 0x28, 0x41, 0x04, 0x00, 0x30, 0x37, 0x02, 0x03]),
  kitchenEscB: Buffer.from([0x1b, 0x42, 0x03, 0x03]),
  kitchenBel: Buffer.from([0x07, 0x07, 0x07]),
};
const RINGING = Object.keys(BEEPS);
/** Every table the agent re-encodes to (B, C, D1–D3, F, ASCII); E is tested on its own. */
const TABLES = Object.keys(TEXT_TABLES);

/** `buf` without the `len` bytes at `at`. */
const cut = (buf, at, len) => Buffer.concat([buf.subarray(0, at), buf.subarray(at + len)]);

/** Raster-mode output as commands; images are skipped whole, so their pixels never read as a beep. */
function walk(out) {
  const commands = [];
  let images = 0;
  let i = 0;
  const take = (name, len) => {
    commands.push({ name, at: i, raw: out.subarray(i, i + len) });
    i += len;
  };
  while (i < out.length) {
    const [b, op] = [out[i], out[i + 1]];
    if (b === 0x1d && op === 0x76) {
      const wb = out[i + 4] | (out[i + 5] << 8);
      const h = out[i + 6] | (out[i + 7] << 8);
      images += 1;
      i += 8 + wb * h;
    } else if (b === 0x0a) i += 1;
    else if (b === 0x07) take('BEL', 1);
    else if (b === 0x1b && op === 0x40) take('ESC @', 2);
    else if (b === 0x1b && op === 0x28 && out[i + 2] === 0x41) take('ESC ( A', 5 + (out[i + 3] | (out[i + 4] << 8)));
    else if (b === 0x1b && op === 0x42) take('ESC B', 4);
    else if (b === 0x1b && op === 0x64) take('ESC d', 3);
    else if (b === 0x1b && op === 0x70) take('ESC p', 5);
    else if (b === 0x1d && op === 0x56) take('GS V', out[i + 2] === 65 || out[i + 2] === 66 ? 4 : 3);
    else throw new Error(`unexpected byte 0x${b.toString(16)} at ${i}`);
  }
  return { commands, images };
}

const isBeep = ({ name }) => name === 'BEL' || name === 'ESC ( A' || name === 'ESC B';

test('fixtures: the beep sits right after ESC @ + ESC t 91, and is all the builder added', () => {
  const plain = bytes('kitchenOff');
  for (const name of RINGING) {
    const src = bytes(name);
    assert.deepEqual(src.subarray(0, 5), SERVER_HEAD, name);
    assert.deepEqual(src.subarray(5, 5 + BEEPS[name].length), BEEPS[name], name);
    assert.deepEqual(cut(src, 5, BEEPS[name].length), plain, `${name} minus its beep is the plain ticket`);
  }
  assert.deepEqual([...bytes('cancelBel').subarray(0, 6)], [0x1b, 0x40, 0x1b, 0x74, 91, 0x07]);
});

test('ringing tickets are understood, the beep as its own command tokens', () => {
  for (const name of [...RINGING, 'cancelBel', 'testEpson', 'testEscB', 'testBel']) {
    assert.notEqual(tokenizeServerEscpos(bytes(name)), null, name);
  }
  const epson = tokenizeServerEscpos(bytes('kitchenEpson'));
  assert.equal(epson[1].kind, 'table');
  assert.equal(epson[2].kind, 'cmd');
  assert.deepEqual(epson[2].raw, BEEPS.kitchenEpson);
  const escB = tokenizeServerEscpos(bytes('kitchenEscB'));
  assert.deepEqual(escB[2].raw, BEEPS.kitchenEscB);
  const bel = tokenizeServerEscpos(bytes('kitchenBel'));
  for (const t of bel.slice(2, 5)) assert.deepEqual(t, { kind: 'cmd', op: 0x07, raw: Buffer.from([0x07]) });
  assert.notDeepEqual(bel[5].raw, Buffer.from([0x07]), 'exactly three BEL');
});

test('re-encoded to table 91 itself, a ringing ticket comes back byte for byte', () => {
  for (const name of [...RINGING, 'cancelBel', 'testEpson', 'testEscB', 'testBel']) {
    assert.deepEqual(retargetServerEscpos(bytes(name), { n: 91, encoding: 'win1254' }), bytes(name), name);
  }
});

test('B, C, D1–D3, F: the beep passes through once, in place, untouched — only the letters change', () => {
  const plain = bytes('kitchenOff');
  for (const key of TABLES) {
    const table = TEXT_TABLES[key];
    const expected = retargetServerEscpos(plain, table);
    for (const name of RINGING) {
      const out = retargetServerEscpos(bytes(name), table);
      assert.notEqual(out, null, `${name} @ ${key}`);
      // Right after the server's own ESC @ (+ FS . on D) and its ESC t, now table n.
      const head = table.cancelKanji ? [0x1b, 0x40, 0x1c, 0x2e, 0x1b, 0x74, table.n] : [0x1b, 0x40, 0x1b, 0x74, table.n];
      assert.deepEqual([...out.subarray(0, head.length)], head, `${name} @ ${key}`);
      assert.deepEqual(out.subarray(head.length, head.length + BEEPS[name].length), BEEPS[name], `${name} @ ${key}`);
      // Take the beep out again and it is exactly the plain ticket's output: nothing else moved.
      assert.deepEqual(cut(out, head.length, BEEPS[name].length), expected, `${name} @ ${key}`);
    }
  }
});

test('B and F (PC857 13 / 61): the Turkish letters are right with a beep in front', () => {
  for (const key of ['PC857_13', 'PC857_61']) {
    for (const name of [...RINGING, 'cancelBel']) {
      const out = serverTicketBytes(bytes(name), { ...printer, textTable: key }, legacy);
      assert.deepEqual([...out.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, TEXT_TABLES[key].n], `${name} @ ${key}`);
      assert.ok(!out.includes(Buffer.from([0x1b, 0x74, 91])), `${name} @ ${key}: no 91 left`);
      const text = iconv.decode(out, 'cp857');
      for (const word of ['Bahçe 4', 'Ayşe Güngör', 'Çiğ Köfte Dürüm']) assert.ok(text.includes(word), `${name} @ ${key}: ${word}`);
      if (name !== 'cancelBel') {
        for (const word of ['Türk Kahvesi', 'az şekerli', 'acısız, soğansız']) assert.ok(text.includes(word), `${name} @ ${key}: ${word}`);
      }
    }
  }
});

test('E: a ringing ticket is drawn as images and the beep still reaches the printer, once, first', () => {
  const p = { ...printer, textTable: 'RASTER' };
  const plain = serverTicketBytes(bytes('kitchenOff'), p, legacy);
  for (const name of [...RINGING, 'cancelBel']) {
    const src = bytes(name);
    const out = serverTicketBytes(src, p, legacy);
    assert.notDeepEqual(out, Buffer.concat([legacy, src]), `${name} was rasterised`);
    const { commands, images } = walk(out);
    assert.ok(images > 0, name);
    const beeps = commands.filter(isBeep);
    assert.deepEqual(
      Buffer.concat(beeps.map(({ raw }) => raw)),
      name === 'cancelBel' ? Buffer.from([0x07]) : BEEPS[name],
      `${name}: the beep, whole and only once`,
    );
    // The agent's ESC @, the server's ESC @, then the beep — before any paper moves.
    assert.deepEqual(
      commands.slice(0, 2 + beeps.length).map(({ name: n }) => n),
      ['ESC @', 'ESC @', ...beeps.map(({ name: n }) => n)],
      name,
    );
    if (name !== 'cancelBel') {
      assert.deepEqual(cut(out, beeps[0].at, BEEPS[name].length), plain, `${name} minus its beep is the plain ticket's images`);
    }
  }
});

test('"Test sesi": the bare beep goes out under every setting', () => {
  const tests = { testEpson: BEEPS.kitchenEpson.subarray(0, 7), testEscB: Buffer.from([0x1b, 0x42, 0x02]), testBel: Buffer.from([0x07, 0x07]) };
  for (const [name, start] of Object.entries(tests)) {
    const src = bytes(name);
    assert.deepEqual(src.subarray(2, 2 + start.length), start, name);
    for (const textTable of [undefined, 'SERVER']) {
      assert.deepEqual(serverTicketBytes(src, { ...printer, textTable }, legacy), Buffer.concat([legacy, src]), `${name} @ ${textTable}`);
    }
    for (const key of TABLES) {
      const table = TEXT_TABLES[key];
      const prefix = table.cancelKanji ? [0x1b, 0x40, 0x1c, 0x2e, 0x1b, 0x74, table.n] : [0x1b, 0x40, 0x1b, 0x74, table.n];
      const kanji = table.cancelKanji ? [0x1c, 0x2e] : [];
      const out = serverTicketBytes(src, { ...printer, textTable: key }, legacy);
      assert.deepEqual(out, Buffer.concat([Buffer.from(prefix), src.subarray(0, 2), Buffer.from(kanji), src.subarray(2)]), `${name} @ ${key}`);
    }
    const raster = serverTicketBytes(src, { ...printer, textTable: 'RASTER' }, legacy);
    assert.deepEqual(raster, Buffer.concat([Buffer.from([0x1b, 0x40]), src]), `${name} @ E`);
  }
});

test('ESC ( A is bounded: truncated, empty or oversized prints as sent', () => {
  const head = Buffer.concat([SERVER_HEAD, Buffer.from([0x41])]);
  const tail = Buffer.from([0x0a]);
  const epson = (pL, pH, params) => Buffer.concat([head, Buffer.from([0x1b, 0x28, 0x41, pL, pH]), params, tail]);
  const bad = [
    Buffer.concat([head, Buffer.from([0x1b, 0x28, 0x41])]), // no pL pH
    Buffer.concat([head, Buffer.from([0x1b, 0x28, 0x41, 0x04])]), // no pH
    Buffer.concat([head, Buffer.from([0x1b, 0x28, 0x41, 0x04, 0x00, 0x30, 0x37])]), // 2 of 4 params
    epson(0, 0, Buffer.alloc(0)), // nothing to say
    epson(65, 0, Buffer.alloc(65, 0x30)), // past the cap
    epson(4, 1, Buffer.alloc(260, 0x30)), // pH counts 256s
    Buffer.concat([head, Buffer.from([0x1b, 0x28, 0x42, 0x01, 0x00, 0x30]), tail]), // ESC ( B is not a beep
  ];
  for (const src of bad) {
    assert.equal(tokenizeServerEscpos(src), null, src.toString('hex'));
    for (const textTable of ['PC857_13', 'RASTER']) {
      assert.deepEqual(serverTicketBytes(src, { ...printer, textTable }, legacy), Buffer.concat([legacy, src]), src.toString('hex'));
    }
  }
  // At the cap it is still a beep — and its parameters are skipped whole, even
  // when they read like a command (here ESC t 48, which alone would be refused).
  const atCap = Buffer.concat([Buffer.from([0x1b, 0x74, 0x30]), Buffer.alloc(61, 0x30)]);
  const ok = epson(64, 0, atCap);
  const out = retargetServerEscpos(ok, TEXT_TABLES.PC857_13);
  assert.notEqual(out, null);
  assert.ok(out.includes(Buffer.concat([Buffer.from([0x1b, 0x28, 0x41, 64, 0]), atCap])), 'parameters untouched');
});

test('ESC B needs both arguments; other control bytes are still refused', () => {
  const head = Buffer.concat([SERVER_HEAD, Buffer.from([0x41])]);
  for (const src of [
    Buffer.concat([head, Buffer.from([0x1b, 0x42])]),
    Buffer.concat([head, Buffer.from([0x1b, 0x42, 0x03])]),
    Buffer.concat([head, Buffer.from([0x08, 0x0a])]), // BS
    Buffer.concat([head, Buffer.from([0x0d, 0x0a])]), // CR
    Buffer.concat([head, Buffer.from([0x00, 0x0a])]), // NUL
  ]) {
    assert.equal(tokenizeServerEscpos(src), null, src.toString('hex'));
  }
  // BEL anywhere is one token and stays where it was, between the letters.
  const mid = Buffer.concat([head, Buffer.from([0x07]), iconv.encode('ş\n', 'win1254')]);
  const out = retargetServerEscpos(mid, TEXT_TABLES.PC857_13);
  assert.deepEqual(out, Buffer.concat([Buffer.from([0x1b, 0x40, 0x1b, 0x74, 13, 0x41, 0x07]), iconv.encode('ş\n', 'cp857')]));
});
