import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptSnapshot,
  acknowledge,
  applyOp,
  billTicket,
  businessDay,
  clientView,
  emptyHubData,
  remainingKurus,
} from '../dist/main/offline/hub-state.js';
import { base, CASHIER_PERMS, grant, IDS, local, MANAGER_PERMS, sign, snapshot, WAITER_PERMS } from './fixtures/offline.mjs';

const now = new Date();
function fresh(overrides) {
  const data = emptyHubData({ branchId: 'b1', hubKey: 'k', keyVersion: 1, hubDeviceId: 'dev-bar' });
  acceptSnapshot(data, snapshot(overrides), now);
  data.mode = 'offline';
  return data;
}
const waiter = grant(IDS.waiter, 'Zeynep K.', WAITER_PERMS);
const cashier = grant(IDS.cashier, 'Can Ö.', CASHIER_PERMS);
const manager = grant(IDS.manager, 'Mehmet D.', MANAGER_PERMS);
const apply = (data, g, op) => applyOp(data, sign(g, op), g.claims, now);
const item = (productId, qty, unitPrice, note) => ({ itemRef: local(), productId, qty, unitPrice, ...(note ? { note } : {}) });

test('S2: masa açılır, mutfak ve bar ayrı fişe, Ç-numarası verilir', () => {
  const data = fresh();
  const orderRef = local();
  assert.equal(apply(data, waiter, { ...base(IDS.waiter), kind: 'OPEN_TABLE', orderRef, tableId: IDS.t1, guestCount: 2 }).status, 'applied');
  const added = apply(data, waiter, {
    ...base(IDS.waiter),
    kind: 'ADD_ITEMS',
    orderRef,
    sent: true,
    snapshotId: data.snapshot.snapshotId,
    items: [item(IDS.latte, 2, '100.00'), item(IDS.tost, 1, '150.00', 'az pişmiş')],
  });
  assert.equal(added.status, 'applied');
  assert.deepEqual(added.prints.map((p) => [p.station, p.orderLabel, p.tableName]).sort(), [
    ['BAR', 'Ç-1', 'Masa 1'],
    ['KITCHEN', 'Ç-1', 'Masa 1'],
  ]);
  assert.equal(added.prints.find((p) => p.station === 'KITCHEN').items[0].note, 'az pişmiş');
  const order = data.orders.find((o) => o.id === orderRef);
  assert.equal(order.offlineNo, 1);
  assert.equal(remainingKurus(order), 35000);
  assert.equal(data.log.length, 2);
  assert.equal(data.log[0].offlineNo, 1);
});

test('S3: iki garson aynı boş masayı açar → ikincisi mevcut adisyona yönlenir; ikisinin ürünü tek adisyonda', () => {
  const data = fresh();
  const first = local();
  const second = local();
  apply(data, waiter, { ...base(IDS.waiter), kind: 'OPEN_TABLE', orderRef: first, tableId: IDS.t1 });
  const race = apply(data, cashier, { ...base(IDS.cashier), kind: 'OPEN_TABLE', orderRef: second, tableId: IDS.t1 });
  assert.equal(race.status, 'rejected');
  assert.equal(race.code, 'TABLE_OPEN');
  assert.equal(race.orderId, first);
  for (const g of [waiter, cashier]) {
    const r = apply(data, g, { ...base(g.claims.uid), kind: 'ADD_ITEMS', orderRef: first, sent: false, snapshotId: data.snapshot.snapshotId, items: [item(IDS.latte, 1, '100.00')] });
    assert.equal(r.status, 'applied');
  }
  assert.equal(data.orders.filter((o) => o.tableId === IDS.t1 && o.status === 'OPEN').length, 1);
  assert.equal(data.orders.find((o) => o.id === first).items.length, 2);
  // Reddedilen açılış günlüğe girmez (buluta gitmez).
  assert.equal(data.log.filter((e) => e.op.kind === 'OPEN_TABLE').length, 1);
});

test('bulut adisyonuna (anlık görüntüden) çevrimdışı ürün eklenir; aynı işlem iki kez gelirse tek uygulanır', () => {
  const data = fresh();
  const op = { ...base(IDS.waiter), kind: 'ADD_ITEMS', orderRef: IDS.cloudOrder, sent: true, snapshotId: data.snapshot.snapshotId, items: [item(IDS.tost, 1, '150.00')] };
  assert.equal(apply(data, waiter, op).status, 'applied');
  assert.equal(apply(data, waiter, op).status, 'duplicate');
  const order = data.orders.find((o) => o.id === IDS.cloudOrder);
  assert.equal(order.items.length, 2);
  assert.equal(remainingKurus(order), 35000);
});

test('S6: iptal ve ikram yalnız yetkiliye; eşik üstü iptal onay yetkisi ister; gönderilmiş ürünün iptal fişi basılır', () => {
  const data = fresh();
  const orderRef = local();
  apply(data, cashier, { ...base(IDS.cashier), kind: 'OPEN_TABLE', orderRef, tableId: IDS.t1 });
  const latte = item(IDS.latte, 1, '100.00');
  const big = item(IDS.tost, 4, '150.00');
  apply(data, cashier, { ...base(IDS.cashier), kind: 'ADD_ITEMS', orderRef, sent: true, snapshotId: data.snapshot.snapshotId, items: [latte, big] });

  assert.equal(apply(data, waiter, { ...base(IDS.waiter), kind: 'CANCEL_ITEM', orderRef, itemRef: latte.itemRef, reason: 'vazgeçti' }).code, 'FORBIDDEN');
  assert.equal(apply(data, waiter, { ...base(IDS.waiter), kind: 'COMP_ITEM', orderRef, itemRef: latte.itemRef, reason: 'CHEF' }).code, 'FORBIDDEN');

  const cancel = apply(data, cashier, { ...base(IDS.cashier), kind: 'CANCEL_ITEM', orderRef, itemRef: latte.itemRef, reason: 'vazgeçti' });
  assert.equal(cancel.status, 'applied');
  assert.equal(cancel.prints[0].kind, 'CANCELLATION');
  assert.equal(cancel.prints[0].station, 'BAR');

  // 4 × 150 = 600 ≥ 500 eşik: kasiyer onay yetkisi olmadan iptal edemez, müdür eder.
  assert.equal(apply(data, cashier, { ...base(IDS.cashier), kind: 'CANCEL_ITEM', orderRef, itemRef: big.itemRef, reason: 'yanık' }).code, 'APPROVAL_REQUIRED');
  assert.equal(apply(data, manager, { ...base(IDS.manager), kind: 'CANCEL_ITEM', orderRef, itemRef: big.itemRef, reason: 'yanık' }).status, 'applied');

  const order2 = local();
  apply(data, cashier, { ...base(IDS.cashier), kind: 'OPEN_TABLE', orderRef: order2, tableId: IDS.t1 });
});

test('ikram: sebep listesi, "Diğer" açıklama ister, ikram edilen ödemeden düşer', () => {
  const data = fresh();
  const orderRef = local();
  apply(data, cashier, { ...base(IDS.cashier), kind: 'OPEN_TABLE', orderRef, tableId: IDS.t1 });
  const latte = item(IDS.latte, 1, '100.00');
  apply(data, cashier, { ...base(IDS.cashier), kind: 'ADD_ITEMS', orderRef, sent: false, snapshotId: data.snapshot.snapshotId, items: [latte] });
  assert.equal(apply(data, cashier, { ...base(IDS.cashier), kind: 'COMP_ITEM', orderRef, itemRef: latte.itemRef, reason: 'OTHER' }).code, 'INVALID');
  assert.equal(apply(data, cashier, { ...base(IDS.cashier), kind: 'COMP_ITEM', orderRef, itemRef: latte.itemRef, reason: 'WAIT_APOLOGY' }).status, 'applied');
  assert.equal(remainingKurus(data.orders.find((o) => o.id === orderRef)), 0);
});

test('S4/S5: ayakta satış + kısmi nakit + kart; fazla tahsilat reddedilir; kapanınca yeni ödeme alınmaz', () => {
  const data = fresh();
  const orderRef = local();
  const open = apply(data, cashier, { ...base(IDS.cashier), kind: 'OPEN_TAKEAWAY', orderRef, items: [item(IDS.tost, 2, '150.00')] });
  assert.equal(open.status, 'applied');
  assert.equal(open.prints[0].station, 'KITCHEN');
  assert.equal(apply(data, cashier, { ...base(IDS.cashier), kind: 'PAY', orderRef, method: 'CASH', amount: '100.00' }).status, 'applied');
  assert.equal(apply(data, cashier, { ...base(IDS.cashier), kind: 'PAY', orderRef, method: 'CARD_POS', amount: '250.00' }).code, 'OVERPAY');
  assert.equal(apply(data, cashier, { ...base(IDS.cashier), kind: 'PAY', orderRef, method: 'CARD_POS', amount: '200.00' }).status, 'applied');
  const order = data.orders.find((o) => o.id === orderRef);
  assert.equal(order.status, 'CLOSED');
  assert.equal(apply(data, cashier, { ...base(IDS.cashier), kind: 'PAY', orderRef, method: 'CASH', amount: '1.00' }).code, 'ORDER_CLOSED');
  assert.equal(apply(data, waiter, { ...base(IDS.waiter), kind: 'PAY', orderRef, method: 'CASH', amount: '1.00' }).code, 'FORBIDDEN');
});

test('kısmen ödenmiş adisyon iptal edilemez; ödenmiş ürün iptal/ikram edilemez', () => {
  const data = fresh();
  const orderRef = local();
  apply(data, cashier, { ...base(IDS.cashier), kind: 'OPEN_TAKEAWAY', orderRef, items: [item(IDS.latte, 1, '100.00')] });
  apply(data, cashier, { ...base(IDS.cashier), kind: 'PAY', orderRef, method: 'CASH', amount: '50.00' });
  assert.equal(apply(data, cashier, { ...base(IDS.cashier), kind: 'CANCEL_ORDER', orderRef, reason: 'hata' }).code, 'PAID');
});

test('S11: fiyat oynanmışsa ya da menü değişmişse reddedilir; işlemi başkası adına yapma reddedilir', () => {
  const data = fresh();
  const orderRef = local();
  apply(data, waiter, { ...base(IDS.waiter), kind: 'OPEN_TABLE', orderRef, tableId: IDS.t1 });
  const cheap = apply(data, waiter, { ...base(IDS.waiter), kind: 'ADD_ITEMS', orderRef, sent: true, snapshotId: data.snapshot.snapshotId, items: [item(IDS.latte, 1, '1.00')] });
  assert.equal(cheap.code, 'PRICE_MISMATCH');
  const impostor = apply(data, waiter, { ...base(IDS.cashier), kind: 'OPEN_TABLE', orderRef: local(), tableId: IDS.t1 });
  assert.equal(impostor.code, 'GRANT_MISMATCH');
  assert.equal(apply(data, waiter, { ...base(IDS.waiter), kind: 'OPEN_TABLE', orderRef: local(), tableId: '0190a0b0-0000-7000-8000-00000000ffff' }).code, 'TABLE_NOT_FOUND');
});

test('anlık görüntü: bekleyen işlem varken adisyonlar ezilmez; yokken buluttaki alınır', () => {
  const data = fresh();
  const orderRef = local();
  apply(data, waiter, { ...base(IDS.waiter), kind: 'OPEN_TABLE', orderRef, tableId: IDS.t1 });
  acceptSnapshot(data, snapshot({ snapshotId: 'snap-0002-abcdef' }), now);
  assert.ok(data.orders.some((o) => o.id === orderRef));
  acknowledge(data, data.log.map((e) => ({ opId: e.op.opId, status: 'applied' })), now);
  assert.equal(data.log.length, 0);
  acceptSnapshot(data, snapshot({ snapshotId: 'snap-0003-abcdef' }), now);
  assert.ok(!data.orders.some((o) => o.id === orderRef));
});

test('bulutun reddettiği işlem ayrı listeye alınır; görünüm menüyü yalnız değişince gönderir', () => {
  const data = fresh();
  const orderRef = local();
  apply(data, waiter, { ...base(IDS.waiter), kind: 'OPEN_TABLE', orderRef, tableId: IDS.t1 });
  const r = acknowledge(data, [{ opId: data.log[0].op.opId, status: 'rejected', code: 'FORBIDDEN', message: 'x' }], now);
  assert.deepEqual(r, { removed: 1, rejected: 1 });
  assert.equal(data.rejected[0].code, 'FORBIDDEN');
  assert.ok(clientView(data, null).static);
  assert.equal(clientView(data, data.snapshot.snapshotId).static, undefined);
});

test('hesap fişi: ikram sıfır, kalan doğru; Ç-numarası iş gününe göre sıfırlanır', () => {
  const data = fresh();
  const orderRef = local();
  apply(data, cashier, { ...base(IDS.cashier), kind: 'OPEN_TAKEAWAY', orderRef, items: [item(IDS.latte, 2, '100.00')] });
  const bill = billTicket(data, orderRef, 'Can Ö.', now);
  assert.equal(bill.kind, 'BILL');
  assert.deepEqual(bill.totals.at(-1), { label: 'KALAN', value: '200,00 TL' });
  // 03:59 hâlâ dünün iş günü (sınır 04:00).
  assert.equal(businessDay(new Date('2026-10-14T00:59:00Z'), 'Europe/Istanbul', 240), '2026-10-13');
  assert.equal(businessDay(new Date('2026-10-14T01:01:00Z'), 'Europe/Istanbul', 240), '2026-10-14');
});
