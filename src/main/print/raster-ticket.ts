import iconv from 'iconv-lite';
import { FONT_A, FONT_A_BOLD, FONT_B, FONT_B_BOLD, type BitmapFont } from './receipt-font';
import type { ServerToken } from './server-escpos';

/**
 * "E) Görüntü olarak": a server ticket drawn line by line into `GS v 0` images.
 *
 * For printers where no `ESC t` table carries the Turkish letters. The text
 * never reaches the printer as text, so its character tables do not matter —
 * only that it can print a raster, which every printer that prints the logo
 * already does.
 *
 * WHAT IT MIMICS is the printer's own text mode, so the paper looks the same as
 * on a printer that works: Font A is a 12x24 cell and Font B 9x17 (the server
 * lays out 42 / 56 columns against those), `GS !` scales a glyph the way the
 * printer does (whole dots), characters of different heights sit on one
 * bottom line, and a line that runs past the paper wraps.
 *
 * ALIGNMENT IS OURS, not `ESC a`: printers disagree about whether `ESC a`
 * centres a raster (see receipt-header.service.ts in the backend). Each line is
 * placed within the full paper width here and `ESC a` never reaches the printer.
 *
 * Every image is trimmed to its last inked byte column on the right — a
 * left-aligned 20-character line is ~30 bytes a row, not 72.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** Printable dots across the paper: 80 mm heads are 576, 58 mm 384 — the logo strip is drawn to the same 576. */
export function paperDots(width: number): number {
  return width <= 32 ? 384 : 576;
}

/** The text-mode line pitch these printers default to (`ESC 2`, ~3.75 mm). */
const LINE_PITCH = 30;
/** White space under a line of glyphs — what the pitch leaves below a 24-dot Font A line. */
const LINE_GAP = 6;
/**
 * A real ticket is 15–30 KB as images, a 200-line bill ~400 KB. A stream that
 * would grow past this (all text at `GS !` 8x8, say) prints as sent instead of
 * stalling the till drawing gigabytes.
 */
const MAX_RASTER_BYTES = 4_000_000;

class Canvas {
  readonly stride: number;
  readonly bits: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.stride = Math.ceil(width / 8);
    this.bits = new Uint8Array(this.stride * height);
  }

  fill(x: number, y: number, w: number, h: number): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) {
        this.bits[yy * this.stride + (xx >> 3)]! |= 0x80 >> (xx & 7);
      }
    }
  }

  /** White dots on an inked background — `GS B`'s glyphs. */
  clear(x: number, y: number, w: number, h: number): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) {
        this.bits[yy * this.stride + (xx >> 3)]! &= ~(0x80 >> (xx & 7));
      }
    }
  }

  /** `GS v 0` of the inked part, or null for a line with no dots at all. */
  toRaster(): Buffer | null {
    let last = -1;
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i] !== 0) last = Math.max(last, i % this.stride);
    }
    if (last < 0) return null;
    const widthBytes = last + 1;
    const out = Buffer.alloc(8 + widthBytes * this.height);
    out.set([GS, 0x76, 0x30, 0x00, widthBytes & 0xff, widthBytes >> 8, this.height & 0xff, this.height >> 8]);
    for (let y = 0; y < this.height; y++) {
      out.set(this.bits.subarray(y * this.stride, y * this.stride + widthBytes), 8 + y * widthBytes);
    }
    return out;
  }
}

class Glyphs {
  private readonly index = new Map<string, number>();
  private readonly data: Buffer;
  private readonly rowBytes: number;

  /** `cellW` x `cellH` is the printer's cell; the glyph sits at its top-left. */
  constructor(
    private readonly font: BitmapFont,
    readonly cellW: number,
    readonly cellH: number,
  ) {
    this.data = Buffer.from(font.data, 'base64');
    this.rowBytes = Math.ceil(font.width / 8);
    [...font.chars].forEach((ch, i) => this.index.set(ch, i));
  }

  /** `ink` false draws the glyph in white — on an inverted (`GS B`) cell. */
  draw(canvas: Canvas, ch: string, x: number, y: number, wMul: number, hMul: number, ink = true): void {
    const i = this.index.get(ch) ?? this.index.get('?');
    if (i === undefined) return;
    const base = i * this.rowBytes * this.font.height;
    for (let gy = 0; gy < this.font.height; gy++) {
      for (let gx = 0; gx < this.font.width; gx++) {
        const byte = this.data[base + gy * this.rowBytes + (gx >> 3)]!;
        if (!(byte & (0x80 >> (gx & 7)))) continue;
        if (ink) canvas.fill(x + gx * wMul, y + gy * hMul, wMul, hMul);
        else canvas.clear(x + gx * wMul, y + gy * hMul, wMul, hMul);
      }
    }
  }
}

const GLYPHS = {
  A: new Glyphs(FONT_A, 12, 24),
  A_BOLD: new Glyphs(FONT_A_BOLD, 12, 24),
  B: new Glyphs(FONT_B, 9, 17),
  B_BOLD: new Glyphs(FONT_B_BOLD, 9, 17),
};

interface Style {
  fontB: boolean;
  bold: boolean;
  underline: boolean;
  /** `GS B 1`: white on black — the Modern style's total, a kitchen's highlighted note. */
  invert: boolean;
  wMul: number;
  hMul: number;
}

const DEFAULT_STYLE: Style = { fontB: false, bold: false, underline: false, invert: false, wMul: 1, hMul: 1 };

function glyphsFor(style: Style): Glyphs {
  if (style.fontB) return style.bold ? GLYPHS.B_BOLD : GLYPHS.B;
  return style.bold ? GLYPHS.A_BOLD : GLYPHS.A;
}

/** Collects one printed line and turns it into an image when it ends. */
class LineRenderer {
  private cells: Array<{ ch: string; style: Style }> = [];
  private used = 0;
  private align = 0;
  private size = 0;
  readonly out: Buffer[] = [];

  constructor(private readonly paper: number) {}

  get overflow(): boolean {
    return this.size > MAX_RASTER_BYTES;
  }

  push(bytes: Buffer): void {
    this.out.push(bytes);
    this.size += bytes.length;
  }

  /** `align` is read at the first character, as `ESC a` only counts at the start of a line. */
  add(ch: string, style: Style, align: number): void {
    const w = glyphsFor(style).cellW * style.wMul;
    if (this.cells.length > 0 && this.used + w > this.paper) this.flush();
    if (this.cells.length === 0) this.align = align;
    this.cells.push({ ch, style });
    this.used += w;
  }

  /** LF: print the line — or, for an empty one, let the printer feed its own blank line. */
  newline(): void {
    if (!this.flush()) this.push(Buffer.from([LF]));
  }

  /** Prints a pending partial line (before a cut, a logo, a feed). False when there was nothing to print. */
  flush(): boolean {
    if (this.cells.length === 0) return false;
    if (this.overflow) {
      this.cells = [];
      this.used = 0;
      return true;
    }
    const glyphH = Math.max(...this.cells.map(({ style }) => glyphsFor(style).cellH * style.hMul));
    const canvas = new Canvas(this.paper, Math.max(LINE_PITCH, glyphH + LINE_GAP));
    let x = this.align === 1 ? Math.floor((this.paper - this.used) / 2) : this.align === 2 ? this.paper - this.used : 0;
    for (const { ch, style } of this.cells) {
      const g = glyphsFor(style);
      const top = glyphH - g.cellH * style.hMul;
      // The printer inverts the whole character cell, the glyph comes out white.
      if (style.invert) canvas.fill(x, top, g.cellW * style.wMul, g.cellH * style.hMul);
      g.draw(canvas, ch, x, top, style.wMul, style.hMul, !style.invert);
      if (style.underline) canvas.fill(x, glyphH - style.hMul, g.cellW * style.wMul, style.hMul);
      x += g.cellW * style.wMul;
    }
    this.cells = [];
    this.used = 0;
    const raster = canvas.toRaster();
    // A line of spaces has no dots: the printer's own LF feeds the same blank line.
    this.push(raster ?? Buffer.from([LF]));
    return true;
  }
}

/**
 * The tokens of a server ticket (see `tokenizeServerEscpos`) as images.
 *
 * Style commands are consumed here — they shaped the drawing — and never sent:
 * `ESC a` in particular would move the images on printers that apply it to
 * rasters. What the printer still has to do itself passes through untouched:
 * `ESC @`, feeds, the drawer kick, the cut, and the logo (already an image).
 *
 * Null when the images would pass `MAX_RASTER_BYTES`.
 */
export function rasterizeServerTokens(tokens: readonly ServerToken[], paper: number): Buffer | null {
  const lines = new LineRenderer(paper);
  let style: Style = { ...DEFAULT_STYLE };
  let align = 0;

  for (const token of tokens) {
    if (lines.overflow) return null;
    if (token.kind === 'text') {
      for (const ch of iconv.decode(token.bytes, 'win1254')) {
        if (ch === '\n') lines.newline();
        else lines.add(ch, style, align);
      }
      continue;
    }
    if (token.kind === 'table') continue;

    const n = token.raw[2] ?? 0;
    switch (token.op) {
      case (ESC << 8) | 0x40: // ESC @
        lines.flush();
        style = { ...DEFAULT_STYLE };
        align = 0;
        lines.push(token.raw);
        break;
      case (ESC << 8) | 0x61: // ESC a n
        align = n === 1 || n === 49 ? 1 : n === 2 || n === 50 ? 2 : 0;
        break;
      case (ESC << 8) | 0x45: // ESC E n
        style = { ...style, bold: (n & 1) === 1 };
        break;
      case (ESC << 8) | 0x4d: // ESC M n
        style = { ...style, fontB: n === 1 || n === 49 };
        break;
      case (ESC << 8) | 0x21: // ESC ! n
        style = {
          fontB: (n & 0x01) !== 0,
          bold: (n & 0x08) !== 0,
          hMul: n & 0x10 ? 2 : 1,
          wMul: n & 0x20 ? 2 : 1,
          underline: (n & 0x80) !== 0,
          // ESC ! does not touch GS B.
          invert: style.invert,
        };
        break;
      case (GS << 8) | 0x21: // GS ! n
        style = { ...style, wMul: ((n >> 4) & 7) + 1, hMul: (n & 7) + 1 };
        break;
      case (ESC << 8) | 0x2d: // ESC - n — 1/2 (or '1'/'2') on, 0 off
        style = { ...style, underline: n === 1 || n === 2 || n === 49 || n === 50 };
        break;
      case (GS << 8) | 0x42: // GS B n
        style = { ...style, invert: (n & 1) === 1 };
        break;
      default:
        // ESC d (feed), ESC p (drawer), GS V (cut), GS v 0 (logo): the printer's job.
        lines.flush();
        lines.push(token.raw);
    }
  }
  lines.flush();
  return lines.overflow ? null : Buffer.concat(lines.out);
}

/** Plain Font A lines as images — the "E" row of the test slip. */
export function rasterTextLines(text: readonly string[], paper: number): Buffer {
  const lines = new LineRenderer(paper);
  for (const line of text) {
    for (const ch of line) lines.add(ch, DEFAULT_STYLE, 0);
    lines.newline();
  }
  return Buffer.concat(lines.out);
}
