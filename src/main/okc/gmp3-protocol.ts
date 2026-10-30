/**
 * Hugin GMP-3 (FPU) cevapları — biçim, kodlar, tutar çevirileri.
 *
 * KAYNAK: github.com/huginsdk/fpu wiki → "Teknik Döküman" (HATA KODLARI, DURUM
 * KODLARI) ve kütüphanenin `ICompactPrinter` arayüzü. Her çağrı tek bir metin
 * döner: `<HataKodu>|<DurumKodu>|<Parametre1>|…`. Hata kodu 0 = başarılı.
 *
 * Bu dosya saf: cihaz, süreç ve disk bilmez. Para yolunun okuduğu her sayı
 * buradan geçtiği için testleri de burada yoğun.
 */

/** Hugin örnek uygulamasının varsayılanı (FP300Service → TCP port 4444). */
export const GMP3_DEFAULT_PORT = 4444;

/** Sicil: harf + rakam. Yardımcı program aynı kuralı ayrıca uyguluyor. */
export const GMP3_SERIAL_PATTERN = /^[A-Z0-9]{6,12}$/;

export interface Gmp3Response {
  error: number;
  status: number;
  /** Üçüncü alandan itibaren, KONUMSAL — boş alanlar da yerinde kalır. */
  params: string[];
  raw: string;
}

/**
 * `"0|1|0005|0012"` → `{ error: 0, status: 1, params: ['0005', '0012'] }`.
 *
 * Hugin'in örnek uygulaması boş alanları ATLIYORDU (CPResponse.cs) ve bu,
 * boş bir alandan sonraki her parametreyi bir sola kaydırıyordu. Burada
 * konum korunuyor: belgedeki "4. alan Z numarası" gerçekten 4. alandır.
 *
 * İlk iki alan sayı değilse `null` — cevap bozuk demektir ve para yolu onu
 * "başarılı" ya da "ret" diye OKUYAMAZ.
 */
export function parseResponse(raw: string): Gmp3Response | null {
  const parts = raw.trim().split('|');
  const error = toInt(parts[0]);
  const status = toInt(parts[1]);
  if (error === null || status === null) return null;
  return { error, status, params: parts.slice(2).map((part) => part.trim()), raw };
}

function toInt(value: string | undefined): number | null {
  if (value === undefined || !/^\s*\d+\s*$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

/** ÖKC durum kodları. */
export const Gmp3Status = {
  IDLE: 1,
  SELLING: 2,
  SUBTOTAL: 3,
  PAYMENT: 4,
  /** Ödeme tamam, belge kapatılmalı. */
  OPEN_SALE: 5,
  INFO_RECEIPT: 6,
  CUSTOM_RECEIPT: 7,
  IN_SERVICE: 8,
  SERVICE_REQUIRED: 9,
  LOGIN: 10,
  NON_FISCAL: 11,
  /** Elektrik kesintisinden kalan, iptal bekleyen belge. */
  POWER_RECOVERY: 12,
  INVOICE: 13,
  /** ÖKC onay bekliyor (`ClearError`). */
  CONFIRM_REQUIRED: 14,
} as const;

const STATUS_TEXT: Record<number, string> = {
  1: 'Hazır',
  2: 'Satışta',
  3: 'Ara toplamda',
  4: 'Ödeme bekliyor',
  5: 'Ödeme tamam, belge kapanmadı',
  6: 'Bilgi fişi açık',
  7: 'Serbest belge açık',
  8: 'Servis modunda',
  9: 'Servis gerekli',
  10: 'Kasiyer girişi bekliyor',
  11: 'Mali modda değil',
  12: 'İptal bekleyen belge var',
  13: 'Fatura açık',
  14: 'Cihaz onay bekliyor',
};

export function statusText(status: number): string {
  return STATUS_TEXT[status] ?? `Durum ${status}`;
}

/** Cihazda kapatılmamış bir mali belge var mı. */
export function hasOpenDocument(status: number): boolean {
  return (
    status === Gmp3Status.SELLING ||
    status === Gmp3Status.SUBTOTAL ||
    status === Gmp3Status.PAYMENT ||
    status === Gmp3Status.OPEN_SALE ||
    status === Gmp3Status.POWER_RECOVERY ||
    status === Gmp3Status.INVOICE
  );
}

/** Belgedeki "Olası hatalar" ve HATA KODLARI tablosu — cihazın kendi cümlesiyle. */
const ERROR_TEXT: Record<number, string> = {
  1: 'Veri eksik geldi',
  2: 'Veri bozuldu (CRC)',
  3: 'Yazarkasa bu işlem için uygun durumda değil',
  4: 'Yazarkasa bu komutu desteklemiyor',
  5: 'Geçersiz parametre',
  6: 'İşlem başarısız',
  7: 'Yazarkasa devam onayı bekliyor',
  8: 'Kağıt bitti',
  9: 'Eşleme hatası — bilgisayar yazarkasayla eşleşmemiş',
  11: 'Mali bellek yüklenemedi — servis çağırın',
  12: 'Mali bellek bağlantısı yok — servis çağırın',
  13: 'Mali bellek uyuşmazlığı — servis çağırın',
  17: 'Günlük Z limiti doldu',
  18: 'Mali bellek dolu — servis çağırın',
  20: 'Mali bellek kapalı — servis çağırın',
  22: 'SAM karttan sertifika alınamıyor — servis çağırın',
  32: 'EKÜ çıkarıldı',
  33: 'EKÜ uyuşmazlığı',
  36: 'EKÜ değişikliği için Z raporu gerekli',
  38: 'EKÜ dolu — Z raporu alıp yeni EKÜ takın',
  51: 'Fiş tutar limiti aşıldı',
  52: 'Fişte en fazla 128 kalem olabilir',
  53: 'Geçersiz satış (tutar sıfır)',
  54: 'Geçersiz iptal',
  55: 'Geçersiz düzeltme',
  56: 'Geçersiz indirim/arttırım',
  57: 'Geçersiz ödeme',
  58: 'Ödeme kalemi limiti aşıldı (en fazla 10)',
  59: 'Günlük ürün satış limiti aşıldı — Z raporu gerekli',
  71: 'KDV oranı tanımlı değil',
  72: 'Kısım tanımlı değil',
  74: 'Kredi tipi tanımlı değil',
  91: 'Kasiyer yetkisi yetersiz',
  92: 'Satış var — önce Z raporu',
  93: 'Fiş var — Z raporu gerekli',
  94: 'Çekmecede yeterli nakit yok',
  95: 'Günlük fiş limiti aşıldı — Z raporu gerekli',
  96: 'Günlük toplam limiti aşıldı — Z raporu gerekli',
  97: 'Yazarkasa mali modda değil',
  111: 'Satır uzunluğu fazla',
  112: 'Geçersiz KDV oranı',
  113: 'Geçersiz kısım',
  115: 'Geçersiz ürün adı',
  119: 'Geçersiz adet',
  120: 'Geçersiz tutar',
  131: 'Kapak açıldı — yazarkasa kilitlendi, servis çağırın',
  134: '24 saat doldu — Z raporu alınmalı',
  136: 'Sertifikalar yüklenemedi — servis çağırın',
  137: 'Tarih/saat ayarlanmalı',
  142: 'Sertifika uyuşmazlığı — servis çağırın',
  145: 'Yazarkasayı kapatıp açın',
  146: 'Hatalı şifre hakkı doldu',
  148: 'GİB sunucularına bağlanamıyor — ağ bağlantısını kontrol edin',
  170: 'Bağlı EFT-POS yok',
  171: 'EFT-POS uygun durumda değil',
  172: 'Kart desteklenmiyor',
  173: 'Farklı tutar desteklenmiyor',
  174: 'Banka provizyon vermedi',
  175: 'Taksit desteklenmiyor',
  176: 'Kart ödemesi iptal edilemedi',
};

export function errorText(code: number): string {
  const text = ERROR_TEXT[code];
  return text ? `${text} (${code})` : `Yazarkasa hatası ${code}`;
}

/** Hata kodu → ajanın taşıdığı `code` alanı. PC Link'in `ERR_*` adlarıyla çakışmaz. */
export function errorCode(code: number): string {
  return `GMP3_${code}`;
}

/** Kuruş → GMP-3'ün tutar metni (`12550` → `"125.50"`). */
export function minorToAmount(minor: number): string {
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Kuruş → JSON belgesindeki sayı. `12550 / 100` JS'de tam `125.5` yazılır. */
export function minorToNumber(minor: number): number {
  return minor / 100;
}

/**
 * Cihazın ya da belgenin tutar metni → kuruş.
 *
 * İKİ AYRAÇ DA KABUL: Türkçe Windows'ta kütüphane `125,50` yazabilir, belge
 * `125.50` örneği veriyor. Binlik ayracı hiçbir örnekte yok; iki ayraç birden
 * geçen metin reddedilir — tahmin etmek, 100 kat yanlış tutar demek.
 */
export function amountToMinor(text: string | undefined): number | null {
  const value = text?.trim() ?? '';
  const match = /^(-)?(\d+)(?:[.,](\d{1,2}))?$/.exec(value);
  if (!match?.[2]) return null;
  const whole = Number.parseInt(match[2], 10);
  const fraction = Number.parseInt((match[3] ?? '0').padEnd(2, '0'), 10);
  const minor = whole * 100 + fraction;
  return match[1] ? -minor : minor;
}

/**
 * PC Link'in fiş numarası biçimi `ZZZZ_NNNN` — backend Z ve fiş numarasını
 * buradan okuyor (`zNumberOf`), iki yolun aynı biçimi taşıması mutabakatı tek
 * kurala bağlıyor.
 */
export function receiptNoOf(zNo: number, documentNo: number): string {
  return `${String(zNo).padStart(4, '0')}_${String(documentNo).padStart(4, '0')}`;
}

export interface Gmp3LastDocument {
  documentNo: number;
  zNo: number;
}

/** `GetLastDocumentInfo`: `<Hata>|<Durum>|<BelgeNo>|<ZNo>|<EKÜNo>|<BelgeTipi>|<Tarih>|<Saat>`. */
export function lastDocumentOf(response: Gmp3Response): Gmp3LastDocument | null {
  if (response.error !== 0) return null;
  const documentNo = toInt(response.params[0]);
  const zNo = toInt(response.params[1]);
  if (documentNo === null || zNo === null) return null;
  return { documentNo, zNo };
}
