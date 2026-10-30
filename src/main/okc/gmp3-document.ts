/**
 * PC Link satış belgesi → GMP-3 JSON belgesi + kart tutarı.
 *
 * Backend iki kablolu Hugin yolu için TEK belge kuruyor (PC Link biçimi,
 * `HUGIN_PCLINK_V1`) ve bunun bilerek böyle kalması gerekiyor: aynı adisyonun
 * iki ayrı kurucudan iki ayrı fişi olmasın. Çeviri burada, cihazın yanında —
 * çünkü çevirinin ihtiyaç duyduğu tek bilgi (kısım ↔ KDV tablosu) cihazın
 * içinde.
 *
 * KAYNAK: huginsdk/fpu wiki → "PrintJSONDocumentDeptOnly", "JSONDocument".
 *
 * İKİ YOLUN ÖNEMLİ FARKI KDV'DE. PC Link kalemi `vatRate` taşıyor ve
 * `departmentId` yalnızca bir tercih. GMP-3 kaleminde KDV alanı YOK: oran
 * kısımdan gelir. Backend'in gönderdiği kısım numarasına körü körüne güvenmek
 * (varsayılan `1`), %10'luk bir ürünü %20'lik kısma yazıp yanlış vergiyle mali
 * fiş kesmek olurdu. Kısım her zaman cihazın kendi tablosunda, kalemin
 * oranıyla eşleşerek seçilir; eşleşme yoksa satış DURUR.
 *
 * Saf fonksiyon: cihaz ve disk bilmez.
 */
import { minorToNumber, amountToMinor } from './gmp3-protocol';

/** Cihazın kısım tablosu: `GetDepartment` + `GetVATRate` ile okunur. */
export interface Gmp3Department {
  deptId: number;
  /** TAM YÜZDE (%10 → `10`). */
  vatRate: number;
}

export interface Gmp3Adjustment {
  /** 0 FEE, 1 PERCENT_FEE, 2 DISCOUNT, 3 PERCENT_DISCOUNT. */
  Type: 0 | 1 | 2 | 3;
  Amount?: number;
  percentage?: number;
}

export interface Gmp3Item {
  Id: 0;
  Quantity: number;
  Price: number;
  Name: string;
  DeptId: number;
  Status: 0;
  Adj: Gmp3Adjustment | null;
}

export interface Gmp3Document {
  FiscalItems: Gmp3Item[];
  Adjustments: Gmp3Adjustment[];
  Payments: { Type: 0; Index: 0; PaidTotal: number }[];
  FooterNotes: string[];
  EndOfReceiptInfo: { CloseReceiptFlag: boolean; BarcodeFlag: false; Barcode: null };
}

export interface Gmp3SalePlan {
  document: Gmp3Document;
  /**
   * Cihazın kendi EFT-POS'una çektirilecek tutar, kuruş. `null` = kart yok,
   * belge JSON'la birlikte kapanır.
   */
  cardAmountMinor: number | null;
  totalMinor: number;
  /** Fiş altı QR düştü mü — GMP-3'te QR yalnızca Vx675'te var. */
  droppedQr: boolean;
}

export class Gmp3DocumentError extends Error {}

/** Belge sınırları (JSONItem / JSONDocument tabloları). */
export const GMP3_LIMITS = {
  MAX_ITEMS: 128,
  /** `Name` — String(max. 20 karakter). */
  NAME_CHARS: 20,
  MAX_FOOTER_LINES: 10,
  /**
   * Fiş altı satırı: belge FP300 için 48, FT202/Vx675 için 32 diyor; T300 için
   * sayı yok. Kısa olanı seçiyoruz — taşan satır `ERR_LINE_LEN` ile bütün
   * satışı düşürürdü. Test cihazında ölçülüp güncellenecek.
   */
  FOOTER_CHARS: 32,
} as const;

interface RawItem {
  name?: unknown;
  amount?: unknown;
  vatRate?: unknown;
  departmentId?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  discount?: { amount?: unknown; rate?: unknown } | null;
}

interface RawDocument {
  items?: unknown;
  payments?: unknown;
  totals?: {
    discounts?: { amount?: unknown; rate?: unknown }[];
    discount?: { amount?: unknown; rate?: unknown };
    surcharge?: { amount?: unknown; rate?: unknown };
  };
  footerNotes?: unknown;
}

export function planGmp3Sale(
  input: Record<string, unknown>,
  departments: readonly Gmp3Department[],
): Gmp3SalePlan {
  const doc = input as RawDocument;
  const items = Array.isArray(doc.items) ? (doc.items as RawItem[]) : [];
  if (items.length === 0) throw new Gmp3DocumentError('Belgede kalem yok');
  if (items.length > GMP3_LIMITS.MAX_ITEMS) {
    throw new Gmp3DocumentError(`Bir fişte en fazla ${GMP3_LIMITS.MAX_ITEMS} kalem olabilir`);
  }

  let netMinor = 0;
  const fiscalItems = items.map((item, index) => {
    const converted = toItem(item, index, departments);
    netMinor += converted.netMinor;
    return converted.item;
  });

  const adjustment = documentAdjustment(doc.totals);
  netMinor += adjustment.minor;

  const payments = Array.isArray(doc.payments)
    ? (doc.payments as { type?: unknown; amount?: unknown }[])
    : [];
  if (payments.length === 0) throw new Gmp3DocumentError('Belgede ödeme yok');
  if (payments.length > 10) throw new Gmp3DocumentError('Bir fişte en fazla 10 ödeme olabilir');

  const cash: Gmp3Document['Payments'] = [];
  let cardAmountMinor: number | null = null;
  let paidMinor = 0;
  for (const payment of payments) {
    const amountMinor = positiveMinor(payment.amount, 'Ödeme tutarı');
    paidMinor += amountMinor;
    if (payment.type === 'CASH') {
      cash.push({ Type: 0, Index: 0, PaidTotal: minorToNumber(amountMinor) });
    } else if (payment.type === 'EFT_POS') {
      /*
       * TEK KART ÖDEMESİ. PC Link de aynı kuralı koyuyor: belgede birden çok
       * EFT_POS varsa öncekiler "Parçalı Ödeme Ekle" ile tamamlanmış olmalı.
       * Backend'in "kalanın tamamı" fişinde, kasadan kartla alınmış eski bir
       * ödeme de EFT_POS olarak geliyor — onu cihaza ikinci kez çektirmek
       * müşteriden iki kez para almak olurdu.
       */
      if (cardAmountMinor !== null) {
        throw new Gmp3DocumentError(
          'Belgede birden fazla kart ödemesi var — yazarkasa tek kart ödemesiyle fiş keser',
        );
      }
      cardAmountMinor = amountMinor;
    } else {
      throw new Gmp3DocumentError(`Bu ödeme tipi yazarkasada desteklenmiyor: ${String(payment.type)}`);
    }
  }

  if (netMinor <= 0) throw new Gmp3DocumentError('Fiş tutarı sıfır ya da eksi olamaz');
  if (netMinor !== paidMinor) {
    throw new Gmp3DocumentError(
      `Fiş dengesiz: kalemler ${minorText(netMinor)} ₺, ödemeler ${minorText(paidMinor)} ₺`,
    );
  }

  const notes = Array.isArray(doc.footerNotes)
    ? (doc.footerNotes as unknown[]).filter((note): note is string => typeof note === 'string')
    : [];
  // `QRT…` / `EAN…` PC Link'te barkod bastırır; GMP-3'te düz satır olarak
  // basılırdı. QR yalnızca Vx675'te var (`PrintReceiptBarcode`), o yüzden düşüyor.
  const barcode = (note: string): boolean => /^(QRT|EAN)/.test(note);
  const footerNotes = notes
    .filter((note) => !barcode(note))
    .map((note) => clip(note.replace(/\s+/g, ' ').trim(), GMP3_LIMITS.FOOTER_CHARS))
    .filter((note) => note.length > 0)
    .slice(0, GMP3_LIMITS.MAX_FOOTER_LINES);

  return {
    document: {
      FiscalItems: fiscalItems,
      Adjustments: adjustment.entry ? [adjustment.entry] : [],
      Payments: cash,
      FooterNotes: footerNotes,
      // Kart varsa belge AÇIK kalır: önce kart çekilir, sonra `CloseReceipt`.
      EndOfReceiptInfo: { CloseReceiptFlag: cardAmountMinor === null, BarcodeFlag: false, Barcode: null },
    },
    cardAmountMinor,
    totalMinor: netMinor,
    droppedQr: notes.some(barcode),
  };
}

function toItem(
  item: RawItem,
  index: number,
  departments: readonly Gmp3Department[],
): { item: Gmp3Item; netMinor: number } {
  const label = typeof item.name === 'string' ? item.name : `${index + 1}. kalem`;
  const name = typeof item.name === 'string' ? item.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new Gmp3DocumentError(`${index + 1}. kalemin adı boş`);

  const quantity = Number(typeof item.quantity === 'string' ? item.quantity : (item.quantity ?? 1));
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Gmp3DocumentError(`"${label}" için geçersiz adet`);
  }
  const grossMinor = positiveMinor(item.amount, `"${label}" tutarı`);
  const unitMinor =
    item.unitPrice === undefined ? grossMinor / quantity : positiveMinor(item.unitPrice, `"${label}" birim fiyatı`);
  // GMP-3 satırı birim fiyat × adet basar. Tutmayan bir satırı göndermek,
  // backend'in hesapladığından farklı bir fiş kesmek olurdu.
  if (!Number.isInteger(unitMinor) || unitMinor * quantity !== grossMinor) {
    throw new Gmp3DocumentError(`"${label}" satır tutarı birim fiyat × adet ile tutmuyor`);
  }

  const vatRate = typeof item.vatRate === 'number' ? item.vatRate : Number.NaN;
  const deptId = departmentFor(vatRate, item.departmentId, departments, label);

  let discountMinor = 0;
  let adj: Gmp3Adjustment | null = null;
  if (item.discount && item.discount.amount !== undefined) {
    discountMinor = positiveMinor(item.discount.amount, `"${label}" indirimi`);
    if (discountMinor >= grossMinor) throw new Gmp3DocumentError(`"${label}" indirimi satır tutarını aşıyor`);
    // Belgedeki örnekte indirim tutarı EKSİ yazılıyor (`"Amount":-0.88`).
    adj = { Type: 2, Amount: -minorToNumber(discountMinor) };
  } else if (item.discount && item.discount.rate !== undefined) {
    // Backend tutar gönderiyor; oranı kabul etmek, kuruşu cihazın
    // yuvarlamasına bırakmak ve denge kontrolünü kaybetmek olurdu.
    throw new Gmp3DocumentError(`"${label}" için yüzdesel indirim desteklenmiyor`);
  }

  return {
    item: {
      Id: 0,
      Quantity: quantity,
      Price: minorToNumber(unitMinor),
      Name: clip(name, GMP3_LIMITS.NAME_CHARS),
      DeptId: deptId,
      Status: 0,
      Adj: adj,
    },
    netMinor: grossMinor - discountMinor,
  };
}

/**
 * Kalemin oranına uyan kısım.
 *
 * Backend'in önerdiği kısım YALNIZCA oranı tutuyorsa kullanılır (kafenin
 * bilinçli eşlemesi). Tutmuyorsa cihazdaki o oranlı İLK kısım — PC Link'te
 * cihazın kendi yaptığı seçim. O oranda kısım yoksa fiş kesilmez.
 */
function departmentFor(
  vatRate: number,
  suggested: unknown,
  departments: readonly Gmp3Department[],
  label: string,
): number {
  if (!Number.isInteger(vatRate) || vatRate < 0 || vatRate > 100) {
    throw new Gmp3DocumentError(`"${label}" için geçersiz KDV oranı`);
  }
  if (typeof suggested === 'number') {
    const match = departments.find((dept) => dept.deptId === suggested && dept.vatRate === vatRate);
    if (match) return match.deptId;
  }
  const first = departments
    .filter((dept) => dept.vatRate === vatRate)
    .sort((a, b) => a.deptId - b.deptId)[0];
  if (!first) {
    throw new Gmp3DocumentError(
      `Yazarkasada %${vatRate} KDV'li kısım tanımlı değil ("${label}") — yazarkasadan kısım tanımlayın`,
    );
  }
  return first.deptId;
}

/**
 * Belge toplamına indirim ya da arttırım. GMP-3 belgesi EN FAZLA BİR tane
 * alıyor (`Adjustments` 0..1); PC Link'in indirim listesi toplanır.
 */
function documentAdjustment(totals: RawDocument['totals']): { minor: number; entry: Gmp3Adjustment | null } {
  const discounts = [
    ...(Array.isArray(totals?.discounts) ? totals.discounts : []),
    ...(totals?.discount ? [totals.discount] : []),
  ];
  let discountMinor = 0;
  for (const discount of discounts) {
    if (discount.rate !== undefined && discount.amount === undefined) {
      throw new Gmp3DocumentError('Belgede yüzdesel indirim desteklenmiyor');
    }
    discountMinor += positiveMinor(discount.amount, 'Belge indirimi');
  }
  const surchargeMinor =
    totals?.surcharge?.amount !== undefined ? positiveMinor(totals.surcharge.amount, 'Belge arttırımı') : 0;

  if (discountMinor > 0 && surchargeMinor > 0) {
    throw new Gmp3DocumentError('Belgede hem indirim hem arttırım var — yazarkasa birini kabul ediyor');
  }
  if (discountMinor > 0) return { minor: -discountMinor, entry: { Type: 2, Amount: -minorToNumber(discountMinor) } };
  if (surchargeMinor > 0) return { minor: surchargeMinor, entry: { Type: 0, Amount: minorToNumber(surchargeMinor) } };
  return { minor: 0, entry: null };
}

function positiveMinor(value: unknown, label: string): number {
  const minor = amountToMinor(typeof value === 'number' ? value.toFixed(2) : (value as string | undefined));
  if (minor === null || minor <= 0) throw new Gmp3DocumentError(`${label} geçersiz`);
  return minor;
}

/** Karakter (kod noktası) sayısıyla keser — Türkçe harfler tek karakter. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : text;
}

function minorText(minor: number): string {
  return `${Math.trunc(minor / 100)},${String(Math.abs(minor) % 100).padStart(2, '0')}`;
}
