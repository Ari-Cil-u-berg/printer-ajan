import {
  LABEL_ALIGNS,
  LABEL_LANGUAGES,
  LABEL_TEXT_SIZES,
  type LabelElement,
  type LabelJob,
} from '../../../shared/types';

/**
 * Sunucudan gelen etiket işinin İZİN LİSTESİYLE doğrulanması. Etiket ajanın kendi
 * penceresinde çizilir ve yazıcıya gider: her sayı aralıkta, her metin sınırlı,
 * logo yalnız PNG veri adresi, QR yalnız '0'/'1'. Bilinmeyen öğe türü ya da alan
 * işi düşürür (failed ack) — sessizce atlanmaz.
 */

export const LABEL_LIMITS = {
  widthMm: [15, 120],
  heightMm: [10, 200],
  gapMm: [0, 10],
  elements: 12,
  text: 120,
  /** QR sürüm 40 = 177 modül. */
  qrModules: 177,
  /** ~220 KB PNG. */
  logoChars: 300_000,
} as const;

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const QR_ROW = /^[01]+$/;

function inRange(value: unknown, [min, max]: readonly [number, number]): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isElement(value: unknown): value is LabelElement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const el = value as Record<string, unknown>;
  switch (el.type) {
    case 'text':
      return (
        onlyKeys(el, ['type', 'text', 'size', 'bold', 'align']) &&
        typeof el.text === 'string' &&
        el.text.length <= LABEL_LIMITS.text &&
        isOneOf(el.size, LABEL_TEXT_SIZES) &&
        (el.bold === undefined || typeof el.bold === 'boolean') &&
        (el.align === undefined || isOneOf(el.align, LABEL_ALIGNS))
      );
    case 'qr': {
      if (!onlyKeys(el, ['type', 'rows']) || !Array.isArray(el.rows)) return false;
      const rows = el.rows as unknown[];
      const size = rows.length;
      return (
        size >= 21 &&
        size <= LABEL_LIMITS.qrModules &&
        rows.every((row) => typeof row === 'string' && row.length === size && QR_ROW.test(row))
      );
    }
    case 'logo':
      return (
        onlyKeys(el, ['type', 'src']) &&
        typeof el.src === 'string' &&
        el.src.length <= LABEL_LIMITS.logoChars &&
        PNG_DATA_URL.test(el.src)
      );
    case 'line':
      return onlyKeys(el, ['type']);
    default:
      return false;
  }
}

export function isLabelJob(value: unknown): value is LabelJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  if (!onlyKeys(job, ['language', 'widthMm', 'heightMm', 'gapMm', 'dpi', 'rotate', 'invert', 'elements'])) return false;
  return (
    isOneOf(job.language, LABEL_LANGUAGES) &&
    inRange(job.widthMm, LABEL_LIMITS.widthMm) &&
    inRange(job.heightMm, LABEL_LIMITS.heightMm) &&
    inRange(job.gapMm, LABEL_LIMITS.gapMm) &&
    (job.dpi === 203 || job.dpi === 300) &&
    (job.rotate === undefined || job.rotate === 0 || job.rotate === 180) &&
    (job.invert === undefined || typeof job.invert === 'boolean') &&
    Array.isArray(job.elements) &&
    job.elements.length > 0 &&
    job.elements.length <= LABEL_LIMITS.elements &&
    job.elements.every(isElement)
  );
}

/** Etiketin yazıcı noktası cinsinden boyu (mm → nokta, `dpi`). */
export function labelDots(job: Pick<LabelJob, 'widthMm' | 'heightMm' | 'dpi'>): { width: number; height: number } {
  const dots = (mm: number) => Math.max(8, Math.round((mm / 25.4) * job.dpi));
  // Genişlik bayta tamamlanır (8 nokta = 1 bayt): resim komutlarının hepsi satırı baytla ölçer.
  return { width: Math.ceil(dots(job.widthMm) / 8) * 8, height: dots(job.heightMm) };
}
