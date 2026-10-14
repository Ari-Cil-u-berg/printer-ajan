import assert from 'node:assert/strict';
import test from 'node:test';

import { renderTicket } from '../dist/main/print/escpos.js';

const printer = { target: { kind: 'network', host: '127.0.0.1', port: 9100 }, codepage: 'CP857', width: 42, cut: true };

test('hesap fişi (BILL): başlık, satır tutarları ve toplamlar basılır; eski fişler değişmez', () => {
  const bill = renderTicket(
    {
      kind: 'BILL',
      station: 'CASHIER',
      orderNo: 'Ç-3',
      tableName: 'Masa 1',
      createdAt: '2026-10-14T18:00:00.000Z',
      items: [{ qty: 2, name: 'Latte', price: '200,00' }],
      totals: [
        { label: 'TOPLAM', value: '200,00 TL' },
        { label: 'KALAN', value: '200,00 TL' },
      ],
      footer: 'ÇEVRİMDIŞI',
    },
    printer,
  ).toString('latin1');
  assert.match(bill, /HESAP/);
  assert.match(bill, /2 x Latte\s+200,00/);
  assert.match(bill, /TOPLAM\s+200,00 TL/);
  assert.match(bill, /KALAN\s+200,00 TL/);

  const order = renderTicket(
    { kind: 'ORDER', station: 'BAR', orderNo: '12', createdAt: '2026-10-14T18:00:00.000Z', items: [{ qty: 1, name: 'Çay' }] },
    printer,
  ).toString('latin1');
  assert.doesNotMatch(order, /TOPLAM/);
});
