import {
  validateOfflineOp,
  type OfflineGrantClaims,
  type OfflineOp,
  type OfflineOrder,
  type OfflineOrderItem,
  type OfflineSnapshot,
  type OfflineStation,
  type SignedOfflineOp,
} from './protocol';

/**
 * YEREL MERKEZİN DURUMU — saf mantık, dosya/ağ yok.
 *
 * İnternet varken buradaki adisyonlar buluttan gelen anlık görüntünün
 * aynısıdır. Kesintide tek doğru kaynak burası: her işlem SIRAYLA uygulanır,
 * böylece iki garson aynı masaya yazsa da çakışma olmaz. Kurallar sunucudakiyle
 * aynı (yetki, fiyat, eşik üstü iptal, ödenmiş ürün, fazla tahsilat) — merkez
 * kabul ettiği bir işlemi sunucu da kabul etmeli; etmezse (kesintide yetkisi
 * alınmış gibi) işlem "işlenemeyen" olarak kalır ve sahibe bildirilir.
 */

/** Sunucudaki `REQUIRED` ile aynı (apps/api/src/offline/offline-sync.service.ts). */
const REQUIRED: Record<OfflineOp['kind'], readonly string[]> = {
  OPEN_TABLE: ['order:create'],
  OPEN_TAKEAWAY: ['order:create'],
  ADD_ITEMS: ['order:create'],
  CANCEL_ITEM: ['order:cancel'],
  CANCEL_ORDER: ['order:cancel'],
  COMP_ITEM: ['order:update', 'order:comp'],
  PAY: ['payment:collect'],
};

/** `packages/types` → `COMP_REASONS`. */
const COMP_REASONS = ['CHEF', 'GUEST_SATISFACTION', 'WAIT_APOLOGY', 'LOYAL_GUEST', 'STAFF', 'OTHER'] as const;

const SENT: ReadonlySet<OfflineOrderItem['status']> = new Set(['PRINTED', 'READY', 'SERVED']);
/** Kapanan adisyon bu kadar süre "son kapananlar"da görünür. */
const CLOSED_VISIBLE_MS = 3 * 60 * 60 * 1000;
/** Tekrar korumasında hatırlanan işlem sayısı (kesinti boyunca yeter). */
const SEEN_MAX = 10_000;
const REJECTED_MAX = 500;

export type HubMode = 'online' | 'offline' | 'draining';

export interface HubData {
  v: 1;
  branchId: string;
  /** Merkez anahtarı (b64url) ve sürümü — buluttan gelir. */
  hubKey: string;
  keyVersion: number;
  hubDeviceId: string;
  snapshot: OfflineSnapshot | null;
  snapshotAt: string | null;
  /** Açık (ve yakın zamanda kapanmış) adisyonlar — ekranların gördüğü. */
  orders: (OfflineOrder & { closedAt?: string })[];
  /** Buluta gönderilmeyi bekleyen işlemler, sırayla. */
  log: SignedOfflineOp[];
  /** Bulutun reddettiği işlemler — ajan ekranında ve sahibe bildirimde. */
  rejected: { op: SignedOfflineOp; code: string; message: string; at: string }[];
  seen: string[];
  seq: number;
  /** Ç-numarası: iş günü başına sıfırlanır. */
  offlineDay: string;
  offlineNo: number;
  mode: HubMode;
}

export interface TicketRequest {
  kind: 'ORDER' | 'CANCELLATION' | 'BILL';
  station: OfflineStation;
  prepStationId: string | null;
  orderLabel: string;
  tableName?: string;
  waiterName?: string;
  at: string;
  items: { qty: number; name: string; note?: string; price?: string }[];
  totals?: { label: string; value: string }[];
  openDrawer?: boolean;
}

export interface ApplyResult {
  status: 'applied' | 'duplicate' | 'rejected';
  code?: string;
  message?: string;
  orderId?: string;
  prints: TicketRequest[];
}

export function emptyHubData(input: { branchId: string; hubKey: string; keyVersion: number; hubDeviceId: string }): HubData {
  return {
    v: 1,
    ...input,
    snapshot: null,
    snapshotAt: null,
    orders: [],
    log: [],
    rejected: [],
    seen: [],
    seq: 0,
    offlineDay: '',
    offlineNo: 0,
    mode: 'online',
  };
}

// ── Para (kuruş, tam sayı — kayan nokta yok) ─────────────────────────────────

export function toKurus(value: string): number {
  const [whole = '0', frac = ''] = value.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

export function fromKurus(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(Math.round(value));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Ödenecek kalan: iptal ve ikram dışı satırlar − indirim − ödenen. */
export function remainingKurus(order: OfflineOrder): number {
  const gross = order.items
    .filter((item) => item.status !== 'CANCELLED' && !item.comped)
    .reduce((sum, item) => sum + toKurus(item.unitPrice) * item.qty, 0);
  return gross - toKurus(order.discountTotal) - toKurus(order.paidTotal);
}

/** Fişteki ad: bulut numarası ya da Ç-12. */
export function orderLabel(order: OfflineOrder): string {
  if (order.orderNo !== null) return String(order.orderNo);
  return order.offlineNo !== null ? `Ç-${order.offlineNo}` : 'Ç';
}

// ── Anlık görüntü ───────────────────────────────────────────────────────────

/**
 * Yeni anlık görüntü geldi. Bekleyen işlem YOKSA adisyonlar buluttakiyle
 * değiştirilir (bulut doğru). Bekleyen işlem varsa (kesinti ya da aktarım
 * sürüyor) yerel adisyonlara dokunulmaz — onlar buluttan daha yeni.
 */
export function acceptSnapshot(data: HubData, snapshot: OfflineSnapshot, now: Date): void {
  data.snapshot = snapshot;
  data.snapshotAt = now.toISOString();
  if (data.log.length === 0) {
    data.orders = snapshot.openOrders.map((order) => ({ ...order, items: order.items.map((item) => ({ ...item })) }));
  }
  data.seq += 1;
}

// ── İşlem uygulama ──────────────────────────────────────────────────────────

export function applyOp(data: HubData, signed: SignedOfflineOp, claims: OfflineGrantClaims, now: Date): ApplyResult {
  const reject = (code: string, message: string, orderId?: string): ApplyResult => ({
    status: 'rejected',
    code,
    message,
    prints: [],
    ...(orderId ? { orderId } : {}),
  });

  const shape = validateOfflineOp(signed.op);
  if (shape) return reject('INVALID', shape);
  const op = signed.op;
  if (data.seen.includes(op.opId)) return { status: 'duplicate', prints: [] };
  if (!data.snapshot) return reject('NO_SNAPSHOT', 'Merkez henüz şubenin verisini almadı');
  if (op.by !== claims.uid) return reject('GRANT_MISMATCH', 'İşlemi yapan kişi izindeki kişi değil');
  for (const permission of REQUIRED[op.kind]) {
    if (!claims.perms.includes(permission as never)) return reject('FORBIDDEN', 'Bu işlem için yetkiniz yok');
  }
  const snapshot = data.snapshot;
  const at = op.at;
  const prints: TicketRequest[] = [];
  let offlineNo: number | undefined;

  const findOrder = (ref: string) => data.orders.find((order) => order.id === ref);
  const tableName = (tableId: string | null) => snapshot.tables.find((table) => table.id === tableId)?.name;
  const productOf = (id: string) => snapshot.products.find((product) => product.id === id);

  const buildLines = (items: { itemRef: string; productId: string; qty: number; note?: string; unitPrice: string }[]) => {
    const lines: OfflineOrderItem[] = [];
    for (const item of items) {
      const product = productOf(item.productId);
      if (!product) return { error: reject('PRODUCT_NOT_FOUND', 'Ürün menüde yok') };
      if (!product.available) return { error: reject('UNAVAILABLE', `${product.name} şu an satışta değil`) };
      if (toKurus(product.price) !== toKurus(item.unitPrice)) {
        return { error: reject('PRICE_MISMATCH', `${product.name} fiyatı değişmiş; ekranı yenileyin`) };
      }
      lines.push({
        id: item.itemRef,
        productId: product.id,
        name: product.name,
        qty: item.qty,
        unitPrice: product.price,
        station: product.station,
        prepStationId: product.prepStationId,
        note: item.note ?? null,
        status: 'PENDING',
        comped: false,
        paidQty: 0,
        offline: true,
      });
    }
    return { lines };
  };

  const ticketsFor = (order: OfflineOrder, kind: 'ORDER' | 'CANCELLATION', lines: OfflineOrderItem[]) => {
    const groups = new Map<string, TicketRequest>();
    for (const line of lines) {
      const key = `${line.station}:${line.prepStationId ?? ''}`;
      const group =
        groups.get(key) ??
        ({
          kind,
          station: line.station,
          prepStationId: line.prepStationId,
          orderLabel: orderLabel(order),
          ...(tableName(order.tableId) ? { tableName: tableName(order.tableId) } : {}),
          waiterName: claims.name,
          at,
          items: [],
        } satisfies TicketRequest);
      group.items.push({ qty: line.qty, name: line.name, ...(line.note ? { note: line.note } : {}) });
      groups.set(key, group);
    }
    prints.push(...groups.values());
  };

  const sentValueKurus = (lines: OfflineOrderItem[]) =>
    lines.filter((line) => SENT.has(line.status)).reduce((sum, line) => sum + toKurus(line.unitPrice) * line.qty, 0);

  const needsVoidApproval = (lines: OfflineOrderItem[]): boolean => {
    const rule = snapshot.branch.voidApproval;
    if (!rule?.enabled) return false;
    const value = sentValueKurus(lines);
    if (value <= 0 || value < toKurus(rule.threshold)) return false;
    return !claims.perms.includes('item-void:approve' as never);
  };

  switch (op.kind) {
    case 'OPEN_TABLE': {
      if (findOrder(op.orderRef)) return { status: 'duplicate', prints: [], orderId: op.orderRef };
      if (!snapshot.tables.some((table) => table.id === op.tableId)) return reject('TABLE_NOT_FOUND', 'Masa bulunamadı');
      const open = data.orders.find((order) => order.tableId === op.tableId && order.status === 'OPEN');
      // Masa zaten açık: yeni adisyon AÇILMAZ, istemci mevcut adisyona yazar.
      if (open) return reject('TABLE_OPEN', 'Masa zaten açık', open.id);
      offlineNo = nextOfflineNo(data, now);
      data.orders.push({
        id: op.orderRef,
        orderNo: null,
        offlineNo,
        channel: 'DINE_IN',
        tableId: op.tableId,
        waiterId: claims.uid,
        waiterName: claims.name,
        guestCount: op.guestCount ?? null,
        openedAt: at,
        items: [],
        paidTotal: '0.00',
        discountTotal: '0.00',
        status: 'OPEN',
      });
      break;
    }
    case 'OPEN_TAKEAWAY': {
      if (findOrder(op.orderRef)) return { status: 'duplicate', prints: [], orderId: op.orderRef };
      const built = buildLines(op.items);
      if ('error' in built && built.error) return built.error;
      offlineNo = nextOfflineNo(data, now);
      const lines = (built.lines ?? []).map((line) => ({ ...line, status: 'PRINTED' as const }));
      const order: OfflineOrder = {
        id: op.orderRef,
        orderNo: null,
        offlineNo,
        channel: 'TAKEAWAY',
        tableId: null,
        waiterId: claims.uid,
        waiterName: claims.name,
        guestCount: null,
        openedAt: at,
        items: lines,
        paidTotal: '0.00',
        discountTotal: '0.00',
        status: 'OPEN',
      };
      data.orders.push(order);
      ticketsFor(order, 'ORDER', lines);
      break;
    }
    case 'ADD_ITEMS': {
      const order = findOrder(op.orderRef);
      if (!order) return reject('ORDER_NOT_FOUND', 'Adisyon bulunamadı');
      if (order.status !== 'OPEN') return reject('ORDER_CLOSED', 'Adisyon kapanmış', order.id);
      if (op.snapshotId !== snapshot.snapshotId) {
        // Fiyatlar başka bir görüntüden: istemci eski menüyle çalışıyor.
        const stale = op.items.some((item) => {
          const product = productOf(item.productId);
          return !product || toKurus(product.price) !== toKurus(item.unitPrice);
        });
        if (stale) return reject('PRICE_MISMATCH', 'Menü güncellendi; ekranı yenileyin');
      }
      const built = buildLines(op.items);
      if ('error' in built && built.error) return built.error;
      const lines = (built.lines ?? []).map((line) => (op.sent ? { ...line, status: 'PRINTED' as const } : line));
      order.items.push(...lines);
      if (op.sent) ticketsFor(order, 'ORDER', lines);
      break;
    }
    case 'CANCEL_ITEM': {
      const order = findOrder(op.orderRef);
      if (!order) return reject('ORDER_NOT_FOUND', 'Adisyon bulunamadı');
      if (order.status !== 'OPEN') return reject('ORDER_CLOSED', 'Adisyon kapanmış', order.id);
      const item = order.items.find((line) => line.id === op.itemRef);
      if (!item) return reject('ITEM_NOT_FOUND', 'Ürün bulunamadı', order.id);
      if (item.status === 'CANCELLED') return { status: 'duplicate', prints: [], orderId: order.id };
      if (item.paidQty > 0) return reject('PAID', 'Ödenmiş ürün iptal edilemez', order.id);
      if (needsVoidApproval([item])) return reject('APPROVAL_REQUIRED', 'Bu tutarda iptal için yetkili onayı gerekir', order.id);
      const wasSent = SENT.has(item.status);
      item.status = 'CANCELLED';
      if (wasSent) ticketsFor(order, 'CANCELLATION', [item]);
      break;
    }
    case 'COMP_ITEM': {
      const order = findOrder(op.orderRef);
      if (!order) return reject('ORDER_NOT_FOUND', 'Adisyon bulunamadı');
      if (order.status !== 'OPEN') return reject('ORDER_CLOSED', 'Adisyon kapanmış', order.id);
      if (!(COMP_REASONS as readonly string[]).includes(op.reason)) return reject('INVALID', 'İkram sebebi geçersiz', order.id);
      if (op.reason === 'OTHER' && (op.note?.trim().length ?? 0) < 2) {
        return reject('INVALID', '"Diğer" ikramda kısa bir açıklama yazın', order.id);
      }
      const item = order.items.find((line) => line.id === op.itemRef);
      if (!item || item.status === 'CANCELLED') return reject('ITEM_NOT_FOUND', 'Ürün bulunamadı', order.id);
      if (item.comped) return { status: 'duplicate', prints: [], orderId: order.id };
      if (item.paidQty > 0) return reject('PAID', 'Ödenmiş ürün ikram edilemez', order.id);
      item.comped = true;
      break;
    }
    case 'CANCEL_ORDER': {
      const order = findOrder(op.orderRef);
      if (!order) return reject('ORDER_NOT_FOUND', 'Adisyon bulunamadı');
      if (order.status === 'CANCELLED') return { status: 'duplicate', prints: [], orderId: order.id };
      if (order.status !== 'OPEN') return reject('ORDER_CLOSED', 'Adisyon kapanmış', order.id);
      if (toKurus(order.paidTotal) > 0) return reject('PAID', 'Kısmen ödenmiş adisyon iptal edilemez; önce iade', order.id);
      const live = order.items.filter((line) => line.status !== 'CANCELLED');
      if (needsVoidApproval(live)) return reject('APPROVAL_REQUIRED', 'Bu tutarda iptal için yetkili onayı gerekir', order.id);
      const sent = live.filter((line) => SENT.has(line.status));
      for (const line of live) line.status = 'CANCELLED';
      order.status = 'CANCELLED';
      order.closedAt = at;
      if (sent.length > 0) ticketsFor(order, 'CANCELLATION', sent);
      break;
    }
    case 'PAY': {
      const order = findOrder(op.orderRef);
      if (!order) return reject('ORDER_NOT_FOUND', 'Adisyon bulunamadı');
      if (order.status !== 'OPEN') return reject('ORDER_CLOSED', 'Adisyon kapanmış', order.id);
      const amount = toKurus(op.amount);
      const remaining = remainingKurus(order);
      if (amount > remaining) return reject('OVERPAY', `Kalan ${fromKurus(remaining)}; fazlası para üstüdür`, order.id);
      order.paidTotal = fromKurus(toKurus(order.paidTotal) + amount);
      if (remainingKurus(order) <= 0) {
        order.status = 'CLOSED';
        order.closedAt = at;
      }
      break;
    }
  }

  data.seq += 1;
  data.log.push({ ...signed, seq: data.seq, ...(offlineNo !== undefined ? { offlineNo } : {}) });
  remember(data, op.opId);
  pruneClosed(data, now);
  return { status: 'applied', prints, orderId: op.orderRef };
}

/** Hesap fişi (kasa yazıcısı) — durum değişmez, günlüğe girmez. */
export function billTicket(data: HubData, orderRef: string, waiterName: string, now: Date): TicketRequest | null {
  const order = data.orders.find((row) => row.id === orderRef);
  const snapshot = data.snapshot;
  if (!order || !snapshot) return null;
  const live = order.items.filter((item) => item.status !== 'CANCELLED');
  const gross = live.filter((item) => !item.comped).reduce((sum, item) => sum + toKurus(item.unitPrice) * item.qty, 0);
  const money = (kurus: number) => `${fromKurus(kurus).replace('.', ',')} ${snapshot.branch.currency === 'TRY' ? 'TL' : snapshot.branch.currency}`;
  const totals = [{ label: 'TOPLAM', value: money(gross) }];
  if (toKurus(order.discountTotal) > 0) totals.push({ label: 'İndirim', value: money(-toKurus(order.discountTotal)) });
  if (toKurus(order.paidTotal) > 0) totals.push({ label: 'Ödenen', value: money(toKurus(order.paidTotal)) });
  totals.push({ label: 'KALAN', value: money(Math.max(0, remainingKurus(order))) });
  const table = snapshot.tables.find((row) => row.id === order.tableId)?.name;
  return {
    kind: 'BILL',
    station: 'CASHIER',
    prepStationId: null,
    orderLabel: orderLabel(order),
    ...(table ? { tableName: table } : {}),
    waiterName,
    at: now.toISOString(),
    items: live.map((item) => ({
      qty: item.qty,
      name: item.comped ? `${item.name} (ikram)` : item.name,
      price: item.comped ? '0,00' : fromKurus(toKurus(item.unitPrice) * item.qty).replace('.', ','),
    })),
    totals,
  };
}

/** Bulutun cevabını uygula: aktarılan işlemler günlükten çıkar, reddedilenler ayrı listeye. */
export function acknowledge(
  data: HubData,
  results: { opId: string; status: 'applied' | 'duplicate' | 'rejected'; code?: string; message?: string }[],
  now: Date,
): { removed: number; rejected: number } {
  const byId = new Map(results.map((row) => [row.opId, row]));
  let removed = 0;
  let rejected = 0;
  data.log = data.log.filter((entry) => {
    const result = byId.get(entry.op.opId);
    if (!result) return true;
    removed += 1;
    if (result.status === 'rejected') {
      rejected += 1;
      data.rejected.push({ op: entry, code: result.code ?? 'REJECTED', message: result.message ?? '', at: now.toISOString() });
    }
    return false;
  });
  if (data.rejected.length > REJECTED_MAX) data.rejected = data.rejected.slice(-REJECTED_MAX);
  return { removed, rejected };
}

/** İstemcinin gördüğü durum. `known` aynı görüntüyse menü ve masalar gönderilmez. */
export function clientView(data: HubData, known: string | null) {
  const snapshot = data.snapshot;
  const same = snapshot !== null && known === snapshot.snapshotId;
  return {
    seq: data.seq,
    mode: data.mode,
    pending: data.log.length,
    snapshotId: snapshot?.snapshotId ?? null,
    orders: data.orders,
    ...(snapshot && !same
      ? {
          static: {
            branch: snapshot.branch,
            sections: snapshot.sections,
            tables: snapshot.tables,
            categories: snapshot.categories,
            products: snapshot.products,
            staff: snapshot.staff,
            prepStations: snapshot.prepStations,
          },
        }
      : {}),
  };
}

function nextOfflineNo(data: HubData, now: Date): number {
  const day = businessDay(now, data.snapshot?.branch.timezone ?? 'Europe/Istanbul', data.snapshot?.branch.businessDayStartMinute ?? 240);
  if (data.offlineDay !== day) {
    data.offlineDay = day;
    data.offlineNo = 0;
  }
  data.offlineNo += 1;
  return data.offlineNo;
}

/** İş günü etiketi (YYYY-MM-DD): yerel saatten iş günü başlangıcı kadar geri. */
export function businessDay(now: Date, timezone: string, startMinute: number): string {
  const shifted = new Date(now.getTime() - startMinute * 60_000);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
  } catch {
    return shifted.toISOString().slice(0, 10);
  }
}

function remember(data: HubData, opId: string): void {
  data.seen.push(opId);
  if (data.seen.length > SEEN_MAX) data.seen = data.seen.slice(-SEEN_MAX);
}

function pruneClosed(data: HubData, now: Date): void {
  data.orders = data.orders.filter(
    (order) => order.status === 'OPEN' || !order.closedAt || now.getTime() - Date.parse(order.closedAt) < CLOSED_VISIBLE_MS,
  );
}
