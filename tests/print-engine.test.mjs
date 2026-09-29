/** PrintEngine against a fake TCP:9100 printer — the path a café's network printer takes. */
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { PrintEngine } from '../dist/main/print/engine.js';

async function fakePrinter() {
  const received = [];
  const server = net.createServer((socket) => {
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => received.push(Buffer.concat(chunks)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    received,
    port: server.address().port,
    stop: () => new Promise((r) => server.close(r)),
  };
}

const config = (port) => ({
  target: { kind: 'network', host: '127.0.0.1', port },
  codepage: 'CP857',
  width: 42,
  cut: true,
});

/** The engine now resolves a printer per JOB (by pairing), not per station. */
const resolved = (printer) => () => ({ printer, label: 'Mutfak Yazıcı' });

const waitFor = (fn, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (fn() ? resolve() : Date.now() - t0 > ms ? reject(new Error('timeout')) : setTimeout(tick, 10));
    tick();
  });

test('structured ticket reaches the printer as ESC/POS with the code page selected', async () => {
  const printer = await fakePrinter();
  const engine = new PrintEngine(resolved(config(printer.port)));

  await engine.print({
    jobId: 'j1',
    station: 'BAR',
    copies: 1,
    content: {
      kind: 'ORDER',
      station: 'BAR',
      orderNo: '77',
      tableName: 'Masa 3',
      createdAt: new Date().toISOString(),
      items: [{ qty: 1, name: 'Şalgam' }],
    },
  });

  await waitFor(() => printer.received.length === 1);
  const bytes = printer.received[0];
  assert.deepEqual([...bytes.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 13]);
  assert.ok(bytes.toString('latin1').includes('BAR'));
  await printer.stop();
});

test('backend-rendered escpos is prefixed with the printer\'s own code page', async () => {
  const printer = await fakePrinter();
  const engine = new PrintEngine(resolved({ ...config(printer.port), codepage: 'ISO8859_9' }));

  const payload = Buffer.from('HELLO\n', 'latin1').toString('base64');
  await engine.print({ jobId: 'j2', station: 'BAR', copies: 1, escpos: payload });

  await waitFor(() => printer.received.length === 1);
  const bytes = printer.received[0];
  assert.deepEqual([...bytes.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 47]);
  assert.ok(bytes.toString('latin1').endsWith('HELLO\n'));
  await printer.stop();
});

test('copies are sent once each', async () => {
  const printer = await fakePrinter();
  const engine = new PrintEngine(resolved(config(printer.port)));
  await engine.print({ jobId: 'j3', station: 'BAR', copies: 3, escpos: Buffer.from('X').toString('base64') });
  await waitFor(() => printer.received.length === 3);
  await printer.stop();
});

test('an unconfigured station fails with a message the cashier can act on', async () => {
  const engine = new PrintEngine(resolved(undefined));
  await assert.rejects(
    () => engine.print({ jobId: 'j4', station: 'KITCHEN', copies: 1, escpos: 'AA==' }),
    /yazıcı seçilmemiş/i,
  );
});

test('an unreachable printer surfaces a Turkish error instead of hanging', async () => {
  const printer = await fakePrinter();
  const port = printer.port;
  await printer.stop(); // nothing is listening now
  const engine = new PrintEngine(resolved(config(port)));
  await assert.rejects(
    () => engine.print({ jobId: 'j5', station: 'BAR', copies: 1, escpos: 'AA==' }),
    /bağlanılamadı/i,
  );
});

test('the unconfigured error names the printer record, not just the station', async () => {
  const engine = new PrintEngine(resolved(undefined));
  await assert.rejects(
    () => engine.print({ jobId: 'j6', station: 'KITCHEN', copies: 1, escpos: 'AA==', route: 'dev-1' }),
    /Mutfak Yazıcı/,
  );
});

test('each job goes to the printer of the pairing that delivered it', async () => {
  const kitchenA = await fakePrinter();
  const kitchenB = await fakePrinter();
  const byRoute = { hot: config(kitchenA.port), cold: config(kitchenB.port) };
  const engine = new PrintEngine((job) => ({ printer: byRoute[job.route], label: job.route }));

  // Same station, two printers: routing is by pairing id, never by station.
  await engine.print({ jobId: 'a', station: 'KITCHEN', copies: 1, escpos: 'QQ==', route: 'hot' });
  await engine.print({ jobId: 'b', station: 'KITCHEN', copies: 1, escpos: 'Qg==', route: 'cold' });
  await waitFor(() => kitchenA.received.length === 1 && kitchenB.received.length === 1);
  assert.ok(kitchenA.received[0].toString('latin1').endsWith('A'));
  assert.ok(kitchenB.received[0].toString('latin1').endsWith('B'));
  await kitchenA.stop();
  await kitchenB.stop();
});

test('probe reports reachability', async () => {
  const printer = await fakePrinter();
  const engine = new PrintEngine(resolved(config(printer.port)));
  const target = config(printer.port);
  assert.deepEqual(await engine.probe(target), { ok: true });
  await printer.stop();
  const down = await engine.probe(target);
  assert.equal(down.ok, false);
});
