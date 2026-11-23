import type { LabelJob, LabelLanguage } from '../../../shared/types';

/**
 * Çizilmiş etiket → 1 bitlik resim → yazıcının dili. Saf kod (Electron'suz test edilir).
 *
 * Kaynaklar (23.11.2026):
 *   TSPL  — TSC "TSPL/TSPL2 Programming Manual" BITMAP: `BITMAP X,Y,width(bayt),height(nokta),mode,data`,
 *           mode 0 = OVERWRITE, veri ham bayt; 0 biti = boyalı (siyah) nokta
 *           (TSC örneği + hackernoon "How to print images with TSPL and JavaScript").
 *   ZPL   — Zebra ZPL II `^GF`: `^GFA,toplam,toplam,satırBaşıBayt,hex`; 1 biti = siyah.
 *   EPL   — Zebra EPL2 `GW p1,p2,p3(bayt),p4(nokta),DATA` ham ikili. Bit yönü kılavuzda yazmıyor:
 *           0 = siyah varsayıldı (TSPL ile aynı aile) — cihazda doğrulanacak; ters çıkarsa `invert`.
 *   ESCPOS — Epson `GS v 0`: 1 biti = siyah (fiş logosuyla aynı yol, `raster-ticket.ts`).
 * Bit sırası hepsinde soldan sağa, en anlamlı bit önce.
 */

export interface MonoBitmap {
  width: number;
  height: number;
  bytesPerRow: number;
  /** 1 = siyah, MSB önce, satır satır. */
  data: Buffer;
}

/** Bu parlaklığın altı siyah (0–255). Antialias kenarları ince kalsın diye ortanın biraz üstü. */
export const BLACK_THRESHOLD = 160;

/**
 * BGRA (Electron `NativeImage.toBitmap()`, Chromium'da hep BGRA) → 1 bit. Saydam piksel beyaz.
 * `width` 8'in katı değilse satır sonu beyazla doldurulur.
 */
export function toMono(bgra: Buffer, width: number, height: number, threshold = BLACK_THRESHOLD): MonoBitmap {
  if (bgra.length < width * height * 4) throw new Error('Etiket resmi beklenen boyda değil');
  const bytesPerRow = Math.ceil(width / 8);
  const data = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const b = bgra[i]!;
      const g = bgra[i + 1]!;
      const r = bgra[i + 2]!;
      const a = bgra[i + 3]!;
      // Saydam alan kâğıt rengi (beyaz) sayılır.
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) * (a / 255) + 255 * (1 - a / 255);
      if (lum < threshold) data[y * bytesPerRow + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { width, height, bytesPerRow, data };
}

function inverted(data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = ~data[i]! & 0xff;
  return out;
}

/** mm'yi komutlara yazmak için: en çok iki hane, ondalık nokta. */
function mm(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function dots(valueMm: number, dpi: number): number {
  return Math.round((valueMm / 25.4) * dpi);
}

/** Dilin "siyah" biti 0 mı? (TSPL ve EPL evet.) `invert` ayarı bunu çevirir. */
const ZERO_IS_BLACK: Record<Exclude<LabelLanguage, 'DRIVER'>, boolean> = {
  TSPL: true,
  ZPL: false,
  EPL: true,
  ESCPOS: false,
};

function payload(bmp: MonoBitmap, language: Exclude<LabelLanguage, 'DRIVER'>, invert: boolean): Buffer {
  const flip = ZERO_IS_BLACK[language] !== invert;
  return flip ? inverted(bmp.data) : bmp.data;
}

export function encodeTspl(job: LabelJob, bmp: MonoBitmap): Buffer {
  const head =
    `SIZE ${mm(job.widthMm)} mm,${mm(job.heightMm)} mm\r\n` +
    `GAP ${mm(job.gapMm)} mm,0 mm\r\n` +
    'DIRECTION 0,0\r\nREFERENCE 0,0\r\nCLS\r\n' +
    `BITMAP 0,0,${bmp.bytesPerRow},${bmp.height},0,`;
  return Buffer.concat([
    Buffer.from(head, 'ascii'),
    payload(bmp, 'TSPL', job.invert === true),
    Buffer.from('\r\nPRINT 1,1\r\n', 'ascii'),
  ]);
}

export function encodeZpl(job: LabelJob, bmp: MonoBitmap): Buffer {
  const total = bmp.bytesPerRow * bmp.height;
  const hex = payload(bmp, 'ZPL', job.invert === true).toString('hex').toUpperCase();
  return Buffer.from(
    `^XA^PW${bmp.width}^LL${bmp.height}^LH0,0^FO0,0^GFA,${total},${total},${bmp.bytesPerRow},${hex}^FS^PQ1^XZ\r\n`,
    'ascii',
  );
}

export function encodeEpl(job: LabelJob, bmp: MonoBitmap): Buffer {
  // `N` arabelleği temizler; `q` genişlik, `Q` yükseklik + boşluk (nokta). Önce bir satır sonu:
  // yazıcı yarım kalmış bir önceki komutu bitirsin.
  const head = `\r\nN\r\nq${bmp.width}\r\nQ${bmp.height},${dots(job.gapMm, job.dpi)}\r\nGW0,0,${bmp.bytesPerRow},${bmp.height},`;
  return Buffer.concat([
    Buffer.from(head, 'ascii'),
    payload(bmp, 'EPL', job.invert === true),
    Buffer.from('\r\nP1\r\n', 'ascii'),
  ]);
}

/**
 * ESC/POS etiket modu (fiş + etiket basan yazıcılar): `ESC @` + `GS v 0` + sonraki etiketin
 * başına besleme. Boşluklu etikette `GS FF` (etiket başına git), sürekli rulda `ESC d 3`.
 */
export function encodeEscPos(job: LabelJob, bmp: MonoBitmap): Buffer {
  const header = Buffer.from([
    0x1b, 0x40,
    0x1d, 0x76, 0x30, 0x00,
    bmp.bytesPerRow & 0xff, (bmp.bytesPerRow >> 8) & 0xff,
    bmp.height & 0xff, (bmp.height >> 8) & 0xff,
  ]);
  const feed = job.gapMm > 0 ? Buffer.from([0x1d, 0x0c]) : Buffer.from([0x1b, 0x64, 0x03]);
  return Buffer.concat([header, payload(bmp, 'ESCPOS', job.invert === true), feed]);
}

export function encodeLabel(job: LabelJob, bmp: MonoBitmap): Buffer {
  switch (job.language) {
    case 'TSPL':
      return encodeTspl(job, bmp);
    case 'ZPL':
      return encodeZpl(job, bmp);
    case 'EPL':
      return encodeEpl(job, bmp);
    case 'ESCPOS':
      return encodeEscPos(job, bmp);
    case 'DRIVER':
      throw new Error('Sürücü yolu ham bayt üretmez');
  }
}
