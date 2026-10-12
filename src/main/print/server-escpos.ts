import iconv from 'iconv-lite';
import { RASTER_TABLE, SERVER_TABLE, SERVER_TEXT_TABLE, TEXT_TABLES, type PrinterConfig, type TextTable } from '../../shared/types';
import { paperDots, rasterizeServerTokens, rasterTextLines } from './raster-ticket';

const ESC = 0x1b;
const FS = 0x1c;
const GS = 0x1d;
const LF = 0x0a;

/** `ESC @` as a token op — see `ServerToken`. */
const INIT = (ESC << 8) | 0x40;
/** `FS .` — cancel Chinese (Kanji) character mode. See `TextTable.cancelKanji`. */
const CANCEL_KANJI = Buffer.from([FS, 0x2e]);

/** The table a printer asked for, or undefined to print the server's bytes untouched. */
export function textTableOf(printer: PrinterConfig): TextTable | undefined {
  if (!printer.textTable || printer.textTable === SERVER_TABLE) return undefined;
  return TEXT_TABLES[printer.textTable];
}

const FOLD: Record<string, string> = {
  ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I',
  ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U',
  â: 'a', Â: 'A', î: 'i', Î: 'I', û: 'u', Û: 'U',
  '·': '.',
};

/** One character in `table`'s encoding; ASCII lookalike when the table has no slot for it. */
function encodeChar(char: string, table: TextTable): number[] {
  if (table.encoding !== 'ascii') {
    const bytes = iconv.encode(char, table.encoding);
    if (!(bytes.length === 1 && bytes[0] === 0x3f && char !== '?')) return [...bytes];
  }
  const folded = FOLD[char] ?? '?';
  return [...folded].map((c) => c.charCodeAt(0));
}

export function encodeForTable(text: string, table: TextTable): Buffer {
  const out: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 0x80) out.push(code);
    else out.push(...encodeChar(char, table));
  }
  return Buffer.from(out);
}

/** Bytes after the opcode for the commands the server's builder emits, keyed `prefix << 8 | opcode`. */
const FIXED_ARGS = new Map<number, number>([
  [(ESC << 8) | 0x40, 0], // ESC @   init
  [(ESC << 8) | 0x61, 1], // ESC a n align
  [(ESC << 8) | 0x45, 1], // ESC E n bold
  [(ESC << 8) | 0x4d, 1], // ESC M n font
  [(ESC << 8) | 0x64, 1], // ESC d n feed
  [(ESC << 8) | 0x21, 1], // ESC ! n print mode
  [(ESC << 8) | 0x70, 3], // ESC p m t1 t2 drawer
  [(GS << 8) | 0x21, 1], // GS ! n  size
]);

/**
 * One piece of a server-rendered ticket. `text` is printable Windows-1254 bytes
 * and LF; `table` is the server's `ESC t 91`; `cmd` is any other command it is
 * known to emit, with its arguments (`op` = prefix << 8 | opcode) — the logo's
 * `GS v 0` included, pixels and all.
 */
export type ServerToken =
  | { kind: 'text'; bytes: Buffer }
  | { kind: 'table' }
  | { kind: 'cmd'; op: number; raw: Buffer };

/**
 * Splits a server-rendered ticket into tokens — or null the moment anything is
 * not what the server's builder is known to emit: an unknown command, a
 * different table, a truncated sequence. Guessing at a stream we do not
 * understand would turn a wrong letter into a lost order.
 */
export function tokenizeServerEscpos(src: Buffer): ServerToken[] | null {
  const tokens: ServerToken[] = [];
  let textStart = -1;
  const flush = (end: number): void => {
    if (textStart < 0) return;
    tokens.push({ kind: 'text', bytes: src.subarray(textStart, end) });
    textStart = -1;
  };

  let i = 0;
  while (i < src.length) {
    const b = src[i]!;
    if (b === LF || (b >= 0x20 && b !== 0x7f)) {
      if (textStart < 0) textStart = i;
      i += 1;
      continue;
    }
    if (b !== ESC && b !== GS) return null;
    flush(i);
    const op = src[i + 1];
    if (op === undefined) return null;
    const cmd = (len: number): void => {
      tokens.push({ kind: 'cmd', op: (b << 8) | op, raw: src.subarray(i, i + len) });
      i += len;
    };

    if (b === ESC && op === 0x74) {
      // ESC t n — only the server's own table is understood.
      if (src[i + 2] !== SERVER_TEXT_TABLE.n) return null;
      tokens.push({ kind: 'table' });
      i += 3;
      continue;
    }
    if (b === GS && op === 0x56) {
      // GS V m [n] — function B (m = 65/66) carries a feed count.
      const m = src[i + 2];
      if (m === undefined) return null;
      const len = m === 65 || m === 66 ? 4 : 3;
      if (i + len > src.length) return null;
      cmd(len);
      continue;
    }
    if (b === GS && op === 0x76) {
      // GS v 0 m xL xH yL yH d1…dk — the logo. Its bytes are pixels, not text.
      if (src[i + 2] !== 0x30 || i + 8 > src.length) return null;
      const width = src[i + 4]! | (src[i + 5]! << 8);
      const height = src[i + 6]! | (src[i + 7]! << 8);
      const len = 8 + width * height;
      if (i + len > src.length) return null;
      cmd(len);
      continue;
    }
    const args = FIXED_ARGS.get((b << 8) | op);
    if (args === undefined || i + 2 + args > src.length) return null;
    cmd(2 + args);
  }
  flush(src.length);
  return tokens;
}

/**
 * Re-encodes a server-rendered ticket for `table`.
 *
 * The server writes its Turkish letters in Windows-1254 and selects `ESC t 91`
 * — after `ESC @`, so whatever the agent selected in front of it is gone. On a
 * printer without 91 every "ş" comes out wrong, and no agent setting reached it.
 * This swaps each `ESC t 91` for `table` and re-encodes every byte ≥ 0x80 of
 * TEXT; raster data and command arguments pass through as-is. With
 * `cancelKanji`, every `ESC @` is followed by `FS .`.
 *
 * Returns null — print as sent, as before — for anything `tokenizeServerEscpos`
 * does not recognise.
 */
export function retargetServerEscpos(src: Buffer, table: TextTable): Buffer | null {
  const tokens = tokenizeServerEscpos(src);
  if (!tokens) return null;
  const out: Buffer[] = [];
  for (const token of tokens) {
    if (token.kind === 'text') {
      out.push(encodeForTable(iconv.decode(token.bytes, SERVER_TEXT_TABLE.encoding), table));
    } else if (token.kind === 'table') {
      out.push(Buffer.from([ESC, 0x74, table.n]));
    } else {
      out.push(token.raw);
      if (table.cancelKanji && token.op === INIT) out.push(CANCEL_KANJI);
    }
  }
  return Buffer.concat(out);
}

/** The bytes a server ticket goes out as on `printer` — the one path real tickets AND the test slip take. */
export function serverTicketBytes(payload: Buffer, printer: PrinterConfig, legacyPrefix: Buffer): Buffer {
  if (printer.textTable === RASTER_TABLE) {
    const tokens = tokenizeServerEscpos(payload);
    const images = tokens && rasterizeServerTokens(tokens, paperDots(printer.width));
    if (images) return Buffer.concat([Buffer.from([ESC, 0x40]), images]);
    return Buffer.concat([legacyPrefix, payload]);
  }
  const table = textTableOf(printer);
  if (table) {
    const retargeted = retargetServerEscpos(payload, table);
    if (retargeted) {
      const prefix = table.cancelKanji ? [ESC, 0x40, FS, 0x2e, ESC, 0x74, table.n] : [ESC, 0x40, ESC, 0x74, table.n];
      return Buffer.concat([Buffer.from(prefix), retargeted]);
    }
  }
  return Buffer.concat([legacyPrefix, payload]);
}

/** Rows of the "which line is right?" block: label printed in ASCII, proof line in that table. */
const CALIBRATION: ReadonlyArray<[string, string, TextTable]> = [
  ['A', 'Varsayilan (WPC1254 91)', SERVER_TEXT_TABLE],
  ['B', 'PC857 13', TEXT_TABLES.PC857_13!],
  ['C', 'WPC1254 48', TEXT_TABLES.WPC1254_48!],
  // After A–C: `FS .` stays in effect until the closing `ESC @`.
  ['D1', 'Cince kapali + 1254 91', TEXT_TABLES.FS_WPC1254_91!],
  ['D2', 'Cince kapali + PC857 13', TEXT_TABLES.FS_PC857_13!],
  ['D3', 'Cince kapali + 1254 48', TEXT_TABLES.FS_WPC1254_48!],
];

const PROOF = 'çğıöşü ÇĞİÖŞÜ';

/**
 * The "Test yazdır" slip, built the way the SERVER builds a ticket (`ESC @`,
 * `ESC t 91`, Windows-1254) so it goes through `serverTicketBytes` exactly
 * like a real one: what it shows is what the kitchen will get. The old slip was
 * encoded by the agent itself and came out perfect on printers whose real
 * tickets were garbled.
 */
export function serverStyleTestSlip(heading: string, settingLabel: string): Buffer {
  const enc = (s: string): Buffer => iconv.encode(s, SERVER_TEXT_TABLE.encoding);
  return Buffer.concat([
    Buffer.from([ESC, 0x40, ESC, 0x74, SERVER_TEXT_TABLE.n, ESC, 0x61, 0x01, GS, 0x21, 0x11]),
    enc('TEST FİŞİ\n'),
    Buffer.from([GS, 0x21, 0x00]),
    enc('Ari Adisyon Yazıcı Ajanı\n'),
    Buffer.from([ESC, 0x61, 0x00]),
    enc(`İstasyon : ${heading}\nTürkçe ayarı: ${settingLabel}\n`),
    enc(`Fişlerde Türkçe: ${PROOF}\nÇilekli Şarap, Ilık Çorba, Öğün\n`),
  ]);
}

/**
 * Appended AFTER the slip, outside the retargeting: each row selects its own
 * table, so one slip shows every candidate side by side. Labels stay ASCII so
 * they read the same whichever table is active.
 */
export function calibrationBlock(width: number, cut: boolean): Buffer {
  // `ESC @` first, as every real ticket starts: a test slip printed under a D
  // setting has already sent `FS .`, and A–C must show the printer as a ticket
  // under A–C would find it.
  const parts: Buffer[] = [
    Buffer.from([ESC, 0x40]),
    Buffer.from('-'.repeat(width) + '\nHangi satirda harfler dogru?\n', 'latin1'),
  ];
  for (const [key, label, table] of CALIBRATION) {
    if (table.cancelKanji) parts.push(CANCEL_KANJI);
    parts.push(Buffer.from([ESC, 0x74, table.n]));
    parts.push(Buffer.from(`${key}) ${label}: `, 'latin1'), encodeForTable(PROOF, table), Buffer.from([LF]));
  }
  // E is an image — no table involved, so it is right wherever the logo prints.
  parts.push(rasterTextLines([`E) Goruntu: ${PROOF}`], paperDots(width)));
  parts.push(
    Buffer.from([ESC, 0x40]),
    Buffer.from('Ajanda "Turkce karakterler" ayarini\no satira gore secin. A-D daha hizli,\nE her yazicida calisir.\n', 'latin1'),
    Buffer.from([ESC, 0x64, cut ? 3 : 5]),
  );
  if (cut) parts.push(Buffer.from([GS, 0x56, 66, 0x00]));
  return Buffer.concat(parts);
}
