/**
 * KOPYA — kaynak: ari-adisyon-backend/packages/types/src/offline.ts.
 * Elle değiştirme; `node scripts/sync-offline-protocol.mjs <backend yolu>` ile yenile.
 * Sözleşme `tests/offline-protocol.test.mjs` içindeki sabit vektörlerle kilitli.
 */
/**
 * İNTERNET KESİLİNCE ÇALIŞMA — ortak protokol.
 *
 * Dört taraf aynı dili konuşur: bulut API, kasa (POS), garson uygulaması ve
 * yerel merkez olan ajan (ayrı depo: `ari-adisyon-ajan`, bu dosyanın kopyası
 * `src/main/offline/protocol.ts`). Tasarım: `docs/CEVRIMDISI-CALISMA.md`.
 *
 * Bu dosyada kripto YOK — her tarafın kendi kütüphanesi var (Node `crypto`,
 * tarayıcı WebCrypto, mobilde `@noble`). Ortak olan baytların tarifi:
 *
 *   merkezAnahtarı = HMAC-SHA256(OFFLINE_HUB_SECRET, "hub:v1:{tenantId}:{branchId}:{keyVersion}")
 *   izin           = b64url(JSON(OfflineGrantClaims)) + "." + b64url(HMAC-SHA256(merkezAnahtarı, ilkParça))
 *   izinSırrı      = HMAC-SHA256(merkezAnahtarı, "grant-secret:" + claims.gid)        (32 bayt)
 *   işlemİmzası    = b64url(HMAC-SHA256(izinSırrı, canonicalJson(op)))
 *   zarf           = AES-256-GCM(izinSırrı, nonce 12 bayt, AAD = "{METHOD} {path} {t}")
 *
 * Sözleşmenin doğruluğu `offline.spec.ts`'teki sabit test vektörleriyle
 * kilitlidir; ajan ve mobil aynı vektörleri kendi testlerinde doğrular.
 */

/** Ajanın yerel merkez portu (`0.0.0.0`; kasa `127.0.0.1` üzerinden). */
export const OFFLINE_HUB_PORT = 47821;
export const OFFLINE_PROTOCOL_VERSION = 1;

/** İzin ömrü — 24 saat. Kesinti uzun sürerse işlemin yapıldığı an `exp`'ten önce olmalı. */
export const OFFLINE_GRANT_TTL_SECONDS = 24 * 60 * 60;
/** Bir senkronizasyon partisi en fazla bu kadar işlem. */
export const OFFLINE_SYNC_BATCH_MAX = 100;
/** Bir `ADD_ITEMS` işleminde en fazla satır — çevrimiçi ucun sınırıyla aynı. */
export const OFFLINE_OP_ITEMS_MAX = 50;
/** Merkezin kabul ettiği en büyük istek gövdesi. */
export const OFFLINE_ENVELOPE_MAX_BYTES = 256 * 1024;
/** İstek zaman damgası ve işlem zamanı için kabul edilen saat farkı. */
export const OFFLINE_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Fiyat listesi sunucuda bu kadar tutulur (Redis). */
export const OFFLINE_SNAPSHOT_TTL_SECONDS = 72 * 60 * 60;

/**
 * Çevrimdışı işlemlerin baktığı yetkiler — izne yalnız bunların kişide olanları
 * yazılır. Onay gerektiren hiçbir şey (PIN, uzaktan onay) çevrimdışı yapılamaz:
 * kişinin kendi yetkisi yoksa işlem merkezde de sunucuda da reddedilir.
 */
export const OFFLINE_PERMISSIONS = [
  'order:read',
  'order:create',
  'order:update',
  'order:cancel',
  'order:comp',
  'item-void:approve',
  'payment:collect',
] as const;
export type OfflinePermission = (typeof OFFLINE_PERMISSIONS)[number];

/** İzin içeriği. İmzalı; `secret` ayrı gelir ve burada yoktur. */
export interface OfflineGrantClaims {
  v: 1;
  /** İzin kimliği (rastgele, 16 bayt hex). */
  gid: string;
  /** tenantId */
  tid: string;
  /** branchId */
  bid: string;
  /** userId */
  uid: string;
  /** Ekranda gösterilecek ad ("Ayşe Y."). */
  name: string;
  /** Kişinin çevrimdışı işlemlerdeki yetkileri. */
  perms: OfflinePermission[];
  /** Merkez anahtarının sürümü — merkez değişince artar, eski izinler düşer. */
  kv: number;
  /** Unix saniye */
  iat: number;
  exp: number;
}

/** `POST /offline/grant` cevabı. */
export interface OfflineGrantResponse {
  token: string;
  /** base64url, 32 bayt. Mobilde güvenli depoya, kasada IndexedDB'ye. */
  secret: string;
  expiresAt: string;
  /** Şubenin merkezi; seçilmemişse ya da 24 saattir sesi çıkmadıysa `null`. */
  hub: OfflineHubAddress | null;
}

export interface OfflineHubAddress {
  /** Ajanın bildirdiği özel (RFC 1918) IPv4 adresleri. */
  addresses: string[];
  port: number;
  /** Ajanın cihaz kimliği (eşleşme). */
  deviceId: string;
  seenAt: string;
}

// ── Anlık görüntü (bulut → merkez) ──────────────────────────────────────────

export type OfflineStation = 'BAR' | 'KITCHEN' | 'CASHIER';

export interface OfflineSnapshot {
  v: 1;
  snapshotId: string;
  generatedAt: string;
  branch: {
    id: string;
    name: string;
    /** "TRY" */
    currency: string;
    /** İş günü sınırı, yerel gece yarısından dakika. */
    businessDayStartMinute: number;
    timezone: string;
    /** Eşik üstü iptal onayı (inventory_advanced). */
    voidApproval: { enabled: boolean; threshold: string } | null;
  };
  sections: { id: string; name: string; sort: number }[];
  tables: { id: string; name: string; sectionId: string | null; sort: number }[];
  categories: { id: string; name: string; sort: number }[];
  products: OfflineProduct[];
  /** Yalnız masa ve ayakta satış adisyonları; paket servis yok. */
  openOrders: OfflineOrder[];
  /** Ad ve rol — PIN, e-posta, telefon YOK. */
  staff: { id: string; name: string }[];
  prepStations: { id: string; name: string; station: OfflineStation }[];
  /**
   * Şubenin ajan yazıcıları — merkez fişi sunucuyla AYNI kuralla yönlendirir:
   * yazıcının hazırlık istasyonu listesi istasyonu içeriyorsa, ya da liste boş
   * ve istasyon türü yazıcının istasyonlarındaysa. Merkez yalnız kendi
   * bilgisayarındaki eşleşmelere basabilir.
   */
  printers: OfflinePrinterRoute[];
}

export interface OfflinePrinterRoute {
  deviceId: string;
  name: string;
  stations: OfflineStation[];
  prepStationIds: string[];
  hasCashDrawer: boolean;
  autoPrintBill: boolean;
}

export interface OfflineProduct {
  id: string;
  name: string;
  categoryId: string | null;
  /** Ondalık metin ("125.00") — kayan nokta yok. */
  price: string;
  vatPercent: number | null;
  station: OfflineStation;
  prepStationId: string | null;
  available: boolean;
  sort: number;
}

export type OfflineItemStatus = 'PENDING' | 'PRINTED' | 'READY' | 'SERVED' | 'CANCELLED';

export interface OfflineOrderItem {
  /** Bulut satırı ise sunucu kimliği; çevrimdışı eklenmişse `local:` önekli istemci kimliği. */
  id: string;
  productId: string | null;
  name: string;
  qty: number;
  unitPrice: string;
  station: OfflineStation;
  prepStationId: string | null;
  note: string | null;
  status: OfflineItemStatus;
  /** İkram edilmiş mi (fiyatı adisyona eklenmez). */
  comped: boolean;
  paidQty: number;
  /** Çevrimdışı yapıldı mı (merkezde üretildi). */
  offline?: boolean;
}

export interface OfflineOrder {
  /** Bulut adisyonu ise sunucu kimliği; çevrimdışı açılmışsa `local:` önekli. */
  id: string;
  /** Bulut numarası; çevrimdışında `null`. */
  orderNo: number | null;
  /** Çevrimdışı geçici numara (Ç-12 → 12). */
  offlineNo: number | null;
  channel: 'DINE_IN' | 'TAKEAWAY';
  tableId: string | null;
  waiterId: string;
  waiterName: string;
  guestCount: number | null;
  openedAt: string;
  items: OfflineOrderItem[];
  /** Ödenen toplam (ondalık metin). */
  paidTotal: string;
  /** Uygulanmış indirim toplamı (bulutta kalan; çevrimdışında değişmez). */
  discountTotal: string;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
}

// ── İşlemler (istemci → merkez → bulut) ─────────────────────────────────────

interface OpBase {
  /** İstemcide üretilen UUID — tekrar korumasının anahtarı. */
  opId: string;
  /** İşlemin yapıldığı an (ISO). Satır ve ödeme zamanı budur. */
  at: string;
  /** İzni veren kullanıcı (izindeki `uid` ile aynı olmalı). */
  by: string;
}

/** Masa açma. Masa bulutta da açılmışsa sunucuda mevcut adisyona bağlanır. */
export interface OpOpenTable extends OpBase {
  kind: 'OPEN_TABLE';
  orderRef: string;
  tableId: string;
  guestCount?: number;
}

/** Ayakta satış: adisyon ve satırlar tek işlemde. */
export interface OpOpenTakeaway extends OpBase {
  kind: 'OPEN_TAKEAWAY';
  orderRef: string;
  items: OfflineOpItem[];
}

export interface OfflineOpItem {
  /** `local:` önekli istemci satır kimliği. */
  itemRef: string;
  productId: string;
  qty: number;
  note?: string;
  /** Müşteriye uygulanan fiyat — anlık görüntüdeki fiyat, sunucuda doğrulanır. */
  unitPrice: string;
}

export interface OpAddItems extends OpBase {
  kind: 'ADD_ITEMS';
  orderRef: string;
  items: OfflineOpItem[];
  /** Mutfağa/bara hemen gönderildi mi (merkez fişi bastı). */
  sent: boolean;
  /** Fiyatların geldiği anlık görüntü. */
  snapshotId: string;
}

export interface OpCancelItem extends OpBase {
  kind: 'CANCEL_ITEM';
  orderRef: string;
  itemRef: string;
  reason: string;
  /** Mutfağa gitmiş satır hazırlandı mı. */
  wasPrepared?: boolean;
}

export interface OpCompItem extends OpBase {
  kind: 'COMP_ITEM';
  orderRef: string;
  itemRef: string;
  /** `COMP_REASONS` anahtarı. */
  reason: string;
  note?: string;
}

export interface OpCancelOrder extends OpBase {
  kind: 'CANCEL_ORDER';
  orderRef: string;
  reason: string;
  wasPrepared?: boolean;
}

export interface OpPay extends OpBase {
  kind: 'PAY';
  orderRef: string;
  method: 'CASH' | 'CARD_POS';
  /** Ondalık metin. */
  amount: string;
}

export type OfflineOp =
  | OpOpenTable
  | OpOpenTakeaway
  | OpAddItems
  | OpCancelItem
  | OpCompItem
  | OpCancelOrder
  | OpPay;

export type OfflineOpKind = OfflineOp['kind'];

/** Merkezin buluta gönderdiği zarf: işlem + kim imzaladı. */
export interface SignedOfflineOp {
  op: OfflineOp;
  /** İşlemi yapan cihazın izni. */
  grant: string;
  /** `b64url(HMAC-SHA256(izinSırrı, canonicalJson(op)))` */
  mac: string;
  /** Merkezin verdiği sıra numarası. */
  seq: number;
  /** Çevrimdışı geçici numara (yalnız açılış işlemlerinde). */
  offlineNo?: number;
}

export type OfflineSyncStatus = 'applied' | 'duplicate' | 'rejected';

export interface OfflineSyncResult {
  opId: string;
  status: OfflineSyncStatus;
  /** Reddin makine kodu (`FORBIDDEN`, `PRICE_MISMATCH`, `ORDER_NOT_FOUND`…). */
  code?: string;
  message?: string;
  /** Açılış işleminde bulut adisyonunun kimliği ve numarası. */
  orderId?: string;
  orderNo?: number | null;
}

export interface OfflineSyncResponse {
  results: OfflineSyncResult[];
}

/** Merkezin bildirdiği durum (`GET /v1/ping`). Sır içermez. */
export interface OfflineHubPing {
  hub: true;
  v: typeof OFFLINE_PROTOCOL_VERSION;
  branchId: string;
  /** `online`: istemciler buluta gitsin. `offline`: merkeze yazsın. `draining`: aktarılıyor, merkeze yazmaya devam. */
  mode: 'online' | 'offline' | 'draining';
  pending: number;
  snapshotAt: string | null;
}

// ── Doğrulama ve kararlı JSON ────────────────────────────────────────────────

/**
 * Anahtarları sıralı, boşluksuz JSON. İmza bunun üzerinden atılır: aynı işlem
 * her tarafta aynı baytlara dönüşmeli. `undefined` alanlar yazılmaz.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry ?? null)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_REF = /^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY = /^\d{1,9}(\.\d{1,2})?$/;

export function isLocalRef(ref: string): boolean {
  return LOCAL_REF.test(ref);
}

/** Bir adisyona/satıra referans: bulut UUID'si ya da `local:` istemci kimliği. */
function isRef(value: unknown): value is string {
  return typeof value === 'string' && (UUID.test(value) || LOCAL_REF.test(value));
}

function text(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}

/**
 * İşlemin şeklini doğrular (izin listesiyle; bilinmeyen alan reddedilir).
 * Merkez ve sunucu AYNI fonksiyonu çalıştırır — biri kabul edip diğeri
 * reddetmesin. Yetki ve iş kuralları burada değil.
 *
 * @returns hata mesajı, ya da geçerliyse `null`.
 */
export function validateOfflineOp(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'İşlem nesne olmalı';
  const op = raw as Record<string, unknown>;
  if (typeof op.opId !== 'string' || !UUID.test(op.opId)) return 'opId UUID olmalı';
  if (typeof op.at !== 'string' || Number.isNaN(Date.parse(op.at))) return 'at ISO tarih olmalı';
  if (typeof op.by !== 'string' || !UUID.test(op.by)) return 'by kullanıcı kimliği olmalı';

  const allowed: Record<OfflineOpKind, readonly string[]> = {
    OPEN_TABLE: ['orderRef', 'tableId', 'guestCount'],
    OPEN_TAKEAWAY: ['orderRef', 'items'],
    ADD_ITEMS: ['orderRef', 'items', 'sent', 'snapshotId'],
    CANCEL_ITEM: ['orderRef', 'itemRef', 'reason', 'wasPrepared'],
    COMP_ITEM: ['orderRef', 'itemRef', 'reason', 'note'],
    CANCEL_ORDER: ['orderRef', 'reason', 'wasPrepared'],
    PAY: ['orderRef', 'method', 'amount'],
  };
  const kind = op.kind as OfflineOpKind;
  const fields = allowed[kind];
  if (!fields) return 'Bilinmeyen işlem türü';
  for (const key of Object.keys(op)) {
    if (!['opId', 'at', 'by', 'kind', ...fields].includes(key)) return `Bilinmeyen alan: ${key}`;
  }
  if (!isRef(op.orderRef)) return 'orderRef geçersiz';

  switch (kind) {
    case 'OPEN_TABLE':
      if (!isLocalRef(op.orderRef as string)) return 'Açılan adisyon yerel kimlik taşımalı';
      if (typeof op.tableId !== 'string' || !UUID.test(op.tableId)) return 'tableId geçersiz';
      if (op.guestCount !== undefined && (!Number.isInteger(op.guestCount) || (op.guestCount as number) < 1 || (op.guestCount as number) > 99)) {
        return 'guestCount 1–99 olmalı';
      }
      return null;
    case 'OPEN_TAKEAWAY':
      if (!isLocalRef(op.orderRef as string)) return 'Açılan adisyon yerel kimlik taşımalı';
      return validateItems(op.items);
    case 'ADD_ITEMS':
      if (typeof op.sent !== 'boolean') return 'sent mantıksal olmalı';
      if (typeof op.snapshotId !== 'string' || op.snapshotId.length < 8 || op.snapshotId.length > 64) return 'snapshotId geçersiz';
      return validateItems(op.items);
    case 'CANCEL_ITEM':
    case 'COMP_ITEM':
      if (!isRef(op.itemRef)) return 'itemRef geçersiz';
      if (!text(op.reason, 2, 200)) return 'Gerekçe 2–200 karakter olmalı';
      if (op.note !== undefined && !text(op.note, 0, 200)) return 'Not en fazla 200 karakter';
      if (op.wasPrepared !== undefined && typeof op.wasPrepared !== 'boolean') return 'wasPrepared mantıksal olmalı';
      return null;
    case 'CANCEL_ORDER':
      if (!text(op.reason, 2, 200)) return 'Gerekçe 2–200 karakter olmalı';
      if (op.wasPrepared !== undefined && typeof op.wasPrepared !== 'boolean') return 'wasPrepared mantıksal olmalı';
      return null;
    case 'PAY':
      if (op.method !== 'CASH' && op.method !== 'CARD_POS') return 'Çevrimdışı yalnız nakit ve kart (elle)';
      if (typeof op.amount !== 'string' || !MONEY.test(op.amount) || Number(op.amount) <= 0) return 'Tutar geçersiz';
      return null;
  }
}

function validateItems(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return 'En az bir ürün';
  if (raw.length > OFFLINE_OP_ITEMS_MAX) return `En fazla ${OFFLINE_OP_ITEMS_MAX} satır`;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'Satır nesne olmalı';
    const item = entry as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (!['itemRef', 'productId', 'qty', 'note', 'unitPrice'].includes(key)) return `Bilinmeyen satır alanı: ${key}`;
    }
    if (typeof item.itemRef !== 'string' || !LOCAL_REF.test(item.itemRef)) return 'itemRef yerel kimlik olmalı';
    if (typeof item.productId !== 'string' || !UUID.test(item.productId)) return 'productId geçersiz';
    if (!Number.isInteger(item.qty) || (item.qty as number) < 1 || (item.qty as number) > 99) return 'Adet 1–99 olmalı';
    if (item.note !== undefined && !text(item.note, 1, 200)) return 'Not 1–200 karakter';
    if (typeof item.unitPrice !== 'string' || !MONEY.test(item.unitPrice)) return 'Birim fiyat geçersiz';
  }
  return null;
}
