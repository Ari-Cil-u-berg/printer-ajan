import { createHmac, randomUUID } from 'node:crypto';

import { canonicalJson } from '../../dist/main/offline/protocol.js';

/** Testte bulutun yaptığını yapar: şube anahtarıyla izin imzalar. */
export const HUB_KEY = createHmac('sha256', 'test-root').update('hub:v1:t1:b1:1').digest();
export const HUB_KEY_B64 = HUB_KEY.toString('base64url');

export const IDS = {
  t1: '0190a0b0-0000-7000-8000-000000000101',
  t2: '0190a0b0-0000-7000-8000-000000000102',
  latte: '0190a0b0-0000-7000-8000-000000000201',
  tost: '0190a0b0-0000-7000-8000-000000000202',
  barPrep: '0190a0b0-0000-7000-8000-000000000301',
  kitchenPrep: '0190a0b0-0000-7000-8000-000000000302',
  waiter: '0190a0b0-0000-7000-8000-000000000401',
  cashier: '0190a0b0-0000-7000-8000-000000000402',
  manager: '0190a0b0-0000-7000-8000-000000000403',
  cloudOrder: '0190a0b0-0000-7000-8000-000000000501',
  cloudItem: '0190a0b0-0000-7000-8000-000000000502',
};

export function grant(userId, name, perms, { key = HUB_KEY, bid = 'b1', exp } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { v: 1, gid: randomUUID().replace(/-/g, ''), tid: 't1', bid, uid: userId, name, perms, kv: 1, iat: now - 60, exp: exp ?? now + 86400 };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
  const secret = createHmac('sha256', key).update(`grant-secret:${claims.gid}`).digest();
  return { token, secret, claims };
}

export const WAITER_PERMS = ['order:read', 'order:create'];
export const CASHIER_PERMS = ['order:read', 'order:create', 'order:update', 'order:cancel', 'order:comp', 'payment:collect'];
export const MANAGER_PERMS = [...CASHIER_PERMS, 'item-void:approve'];

export function sign(g, op) {
  return { op, grant: g.token, mac: createHmac('sha256', g.secret).update(canonicalJson(op)).digest('base64url'), seq: 0 };
}

export const local = () => `local:${randomUUID()}`;
export const base = (by, at = new Date()) => ({ opId: randomUUID(), at: at.toISOString(), by });

export function snapshot(overrides = {}) {
  return {
    v: 1,
    snapshotId: overrides.snapshotId ?? 'snap-0001-abcdef',
    generatedAt: new Date().toISOString(),
    branch: {
      id: 'b1',
      name: 'Kadıköy',
      currency: 'TRY',
      businessDayStartMinute: 240,
      timezone: 'Europe/Istanbul',
      voidApproval: { enabled: true, threshold: '500.00' },
    },
    sections: [{ id: 's1', name: 'Salon', sort: 0 }],
    tables: [
      { id: IDS.t1, name: 'Masa 1', sectionId: 's1', sort: 1 },
      { id: IDS.t2, name: 'Masa 2', sectionId: 's1', sort: 2 },
    ],
    categories: [{ id: 'c1', name: 'Menü', sort: 0 }],
    products: [
      { id: IDS.latte, name: 'Latte', categoryId: 'c1', price: overrides.lattePrice ?? '100.00', vatPercent: 10, station: 'BAR', prepStationId: null, available: true, sort: 0 },
      { id: IDS.tost, name: 'Tost', categoryId: 'c1', price: '150.00', vatPercent: 10, station: 'KITCHEN', prepStationId: null, available: true, sort: 1 },
    ],
    openOrders: overrides.openOrders ?? [
      {
        id: IDS.cloudOrder,
        orderNo: 41,
        offlineNo: null,
        channel: 'DINE_IN',
        tableId: IDS.t2,
        waiterId: IDS.waiter,
        waiterName: 'Zeynep K.',
        guestCount: 2,
        openedAt: new Date(Date.now() - 600_000).toISOString(),
        items: [
          { id: IDS.cloudItem, productId: IDS.latte, name: 'Latte', qty: 2, unitPrice: '100.00', station: 'BAR', prepStationId: null, note: null, status: 'PRINTED', comped: false, paidQty: 0 },
        ],
        paidTotal: '0.00',
        discountTotal: '0.00',
        status: 'OPEN',
      },
    ],
    staff: [{ id: IDS.waiter, name: 'Zeynep Kaya' }],
    prepStations: [
      { id: IDS.barPrep, name: 'Bar', station: 'BAR' },
      { id: IDS.kitchenPrep, name: 'Mutfak', station: 'KITCHEN' },
    ],
    printers: [
      { deviceId: 'dev-bar', name: 'Bar', stations: ['BAR'], prepStationIds: [IDS.barPrep], hasCashDrawer: false, autoPrintBill: false },
      { deviceId: 'dev-kitchen', name: 'Mutfak', stations: ['KITCHEN'], prepStationIds: [IDS.kitchenPrep], hasCashDrawer: false, autoPrintBill: false },
      { deviceId: 'dev-kasa', name: 'Kasa', stations: ['CASHIER'], prepStationIds: [], hasCashDrawer: true, autoPrintBill: true },
    ],
  };
}

/** Sahte işletim sistemi şifreleyicisi (gerçeği `safeStorage`). */
export const fakeCipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from(`ENC:${Buffer.from(plain).toString('base64')}`),
  decrypt: (data) => Buffer.from(data.toString().slice(4), 'base64').toString(),
};
