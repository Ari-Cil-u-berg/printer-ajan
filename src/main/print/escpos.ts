import iconv from 'iconv-lite';
import { CODEPAGES, CODEPAGE_ENCODING, type PrinterConfig, type TicketModel } from '../../shared/types';

const ESC = 0x1b;
const GS = 0x1d;

const TR_TITLE: Record<TicketModel['kind'], string> = {
  ORDER: 'SİPARİŞ',
  REPRINT: 'TEKRAR BASKI',
  CANCELLATION: '*** İPTAL ***',
};

const STATION_TITLE = { BAR: 'BAR', KITCHEN: 'MUTFAK' } as const;

/**
 * Encodes text to the printer's code page. CP857 covers Turkish (ç ğ ı ş ö ü İ).
 * Unmappable characters fall back to an ASCII lookalike rather than `?`.
 */
export function encodeText(text: string, codepage: string): Buffer {
  const enc = CODEPAGE_ENCODING[codepage] ?? 'cp857';
  if (!iconv.encodingExists(enc)) return iconv.encode(foldToAscii(text), 'ascii');
  const encoded = iconv.encode(text, enc);
  // iconv emits 0x3F ('?') for unmappable chars; retry those as folded ASCII.
  if (encoded.includes(0x3f) && !text.includes('?')) {
    return iconv.encode(foldToAscii(text), enc);
  }
  return encoded;
}

const FOLD: Record<string, string> = {
  ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I',
  ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U',
};

export function foldToAscii(text: string): string {
  return text.replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => FOLD[c] ?? c);
}

export class EscPosBuilder {
  private chunks: Buffer[] = [];

  constructor(private readonly codepage: string, private readonly width: number) {}

  raw(...bytes: number[]): this {
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  /** ESC @ (init) + ESC t n (select code page). */
  init(): this {
    const page = CODEPAGES[this.codepage] ?? CODEPAGES.CP857!;
    return this.raw(ESC, 0x40).raw(ESC, 0x74, page);
  }

  align(mode: 'left' | 'center' | 'right'): this {
    return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[mode]);
  }

  /** ESC ! — bit 4 double-height, bit 5 double-width, bit 3 emphasized. */
  style(opts: { bold?: boolean; doubleHeight?: boolean; doubleWidth?: boolean } = {}): this {
    let n = 0;
    if (opts.bold) n |= 0x08;
    if (opts.doubleHeight) n |= 0x10;
    if (opts.doubleWidth) n |= 0x20;
    return this.raw(ESC, 0x21, n);
  }

  text(value: string): this {
    this.chunks.push(encodeText(value, this.codepage));
    return this;
  }

  line(value = ''): this {
    return this.text(value).raw(0x0a);
  }

  /** Left/right justified on one line; truncates left side if needed. */
  columns(left: string, right: string): this {
    const room = Math.max(0, this.width - right.length - 1);
    const l = left.length > room ? left.slice(0, room) : left;
    return this.line(`${l}${' '.repeat(this.width - l.length - right.length)}${right}`);
  }

  rule(char = '-'): this {
    return this.line(char.repeat(this.width));
  }

  /** Wraps at word boundaries, indenting continuation lines. */
  wrapped(value: string, indent = 0): this {
    const room = this.width - indent;
    const pad = ' '.repeat(indent);
    let current = '';
    for (const word of value.split(/\s+/).filter(Boolean)) {
      if (current && current.length + 1 + word.length > room) {
        this.line(pad + current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
      while (current.length > room) {
        this.line(pad + current.slice(0, room));
        current = current.slice(room);
      }
    }
    if (current) this.line(pad + current);
    return this;
  }

  feed(lines = 4): this {
    return this.raw(ESC, 0x64, lines);
  }

  /** GS V 66 — partial cut with feed. */
  cut(): this {
    return this.raw(GS, 0x56, 66, 0x00);
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export function renderTicket(ticket: TicketModel, printer: PrinterConfig, codepage?: string): Buffer {
  const cp = codepage ?? printer.codepage;
  const b = new EscPosBuilder(cp, printer.width).init();

  b.align('center').style({ bold: true, doubleHeight: true, doubleWidth: true });
  b.line(STATION_TITLE[ticket.station]);
  b.style({ bold: true, doubleHeight: true }).line(TR_TITLE[ticket.kind]);
  b.style().align('left').rule();

  b.columns(`Fiş No: ${ticket.orderNo}`, formatTime(ticket.createdAt));
  if (ticket.tableName) b.line(`Masa  : ${ticket.tableName}`);
  if (ticket.waiterName) b.line(`Garson: ${ticket.waiterName}`);
  b.rule();

  for (const item of ticket.items) {
    b.style({ bold: true }).columns(`${item.qty} x ${item.name}`, '').style();
    for (const opt of item.options ?? []) b.wrapped(`+ ${opt}`, 4);
    if (item.note) b.style({ bold: true }).wrapped(`>> ${item.note}`, 4).style();
  }

  b.rule();
  if (ticket.footer) b.align('center').wrapped(ticket.footer);
  b.feed(printer.cut ? 3 : 5);
  if (printer.cut) b.cut();
  return b.build();
}

/** Turkish-character proof sheet used by the "Test yazdır" button. */
export function renderTestTicket(printer: PrinterConfig, station: string, codepage?: string): Buffer {
  const cp = codepage ?? printer.codepage;
  const b = new EscPosBuilder(cp, printer.width).init();
  b.align('center').style({ bold: true, doubleHeight: true }).line('TEST FİŞİ');
  b.style().line('Ari Adisyon Yazıcı Ajanı').align('left').rule();
  b.line(`İstasyon : ${station}`);
  b.line(`Kod sayfası: ${cp}`);
  b.line(`Saat     : ${formatTime(new Date().toISOString())}`);
  b.rule();
  b.line('Türkçe karakter kontrolü:');
  b.line('ç ğ ı i ö ş ü  Ç Ğ I İ Ö Ş Ü');
  b.line('Çilekli Şarap, Ilık Çorba, Öğün');
  b.rule();
  b.wrapped('Yukarıdaki harfler doğru görünüyorsa kurulum tamamdır. Bozuk görünüyorsa kod sayfasını değiştirin (CP857 / ISO8859-9 / CP1254).');
  b.feed(printer.cut ? 3 : 5);
  if (printer.cut) b.cut();
  return b.build();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
