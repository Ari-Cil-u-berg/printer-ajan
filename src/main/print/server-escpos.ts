import iconv from 'iconv-lite';
import { SERVER_TABLE, SERVER_TEXT_TABLE, TEXT_TABLES, type PrinterConfig, type TextTable } from '../../shared/types';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

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
 * Re-encodes a server-rendered ticket for `table`.
 *
 * The server writes its Turkish letters in Windows-1254 and selects `ESC t 91`
 * — after `ESC @`, so whatever the agent selected in front of it is gone. On a
 * printer without 91 every "ş" comes out wrong, and no agent setting reached it.
 * This walks the stream, swaps each `ESC t 91` for `table` and re-encodes every
 * byte ≥ 0x80 of TEXT; raster data and command arguments pass through as-is.
 *
 * Returns null — print as sent, as before — the moment anything is not what
 * the server's builder is known to emit: an unknown command, a different table,
 * a truncated sequence. Guessing at a stream we do not understand would turn a
 * wrong letter into a lost order.
 */
export function retargetServerEscpos(src: Buffer, table: TextTable): Buffer | null {
  const out: Buffer[] = [];
  let text: number[] = [];
  const flush = (): void => {
    if (text.length === 0) return;
    out.push(encodeForTable(iconv.decode(Buffer.from(text), SERVER_TEXT_TABLE.encoding), table));
    text = [];
  };

  let i = 0;
  while (i < src.length) {
    const b = src[i]!;
    if (b === LF || (b >= 0x20 && b !== 0x7f)) {
      text.push(b);
      i += 1;
      continue;
    }
    if (b !== ESC && b !== GS) return null;
    flush();
    const op = src[i + 1];
    if (op === undefined) return null;

    if (b === ESC && op === 0x74) {
      // ESC t n — only the server's own table is understood.
      if (src[i + 2] !== SERVER_TEXT_TABLE.n) return null;
      out.push(Buffer.from([ESC, 0x74, table.n]));
      i += 3;
      continue;
    }
    if (b === GS && op === 0x56) {
      // GS V m [n] — function B (m = 65/66) carries a feed count.
      const m = src[i + 2];
      if (m === undefined) return null;
      const len = m === 65 || m === 66 ? 4 : 3;
      if (i + len > src.length) return null;
      out.push(src.subarray(i, i + len));
      i += len;
      continue;
    }
    if (b === GS && op === 0x76) {
      // GS v 0 m xL xH yL yH d1…dk — the logo. Its bytes are pixels, not text.
      if (src[i + 2] !== 0x30 || i + 8 > src.length) return null;
      const width = src[i + 4]! | (src[i + 5]! << 8);
      const height = src[i + 6]! | (src[i + 7]! << 8);
      const end = i + 8 + width * height;
      if (end > src.length) return null;
      out.push(src.subarray(i, end));
      i = end;
      continue;
    }
    const args = FIXED_ARGS.get((b << 8) | op);
    if (args === undefined || i + 2 + args > src.length) return null;
    out.push(src.subarray(i, i + 2 + args));
    i += 2 + args;
  }
  flush();
  return Buffer.concat(out);
}

/** The bytes a server ticket goes out as on `printer` — the one path real tickets AND the test slip take. */
export function serverTicketBytes(payload: Buffer, printer: PrinterConfig, legacyPrefix: Buffer): Buffer {
  const table = textTableOf(printer);
  if (table) {
    const retargeted = retargetServerEscpos(payload, table);
    if (retargeted) return Buffer.concat([Buffer.from([ESC, 0x40, ESC, 0x74, table.n]), retargeted]);
  }
  return Buffer.concat([legacyPrefix, payload]);
}

/** Rows of the "which line is right?" block: label printed in ASCII, proof line in that table. */
const CALIBRATION: ReadonlyArray<[string, string, TextTable]> = [
  ['A', 'Varsayilan (WPC1254 91)', SERVER_TEXT_TABLE],
  ['B', 'PC857 13', TEXT_TABLES.PC857_13!],
  ['C', 'WPC1254 48', TEXT_TABLES.WPC1254_48!],
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
  const parts: Buffer[] = [Buffer.from('-'.repeat(width) + '\nHangi satirda harfler dogru?\n', 'latin1')];
  for (const [key, label, table] of CALIBRATION) {
    parts.push(Buffer.from([ESC, 0x74, table.n]));
    parts.push(Buffer.from(`${key}) ${label}: `, 'latin1'), encodeForTable(PROOF, table), Buffer.from([LF]));
  }
  parts.push(
    Buffer.from([ESC, 0x40]),
    Buffer.from('Ajanda "Turkce karakterler" ayarini\no satira gore secin.\n', 'latin1'),
    Buffer.from([ESC, 0x64, cut ? 3 : 5]),
  );
  if (cut) parts.push(Buffer.from([GS, 0x56, 66, 0x00]));
  return Buffer.concat(parts);
}
