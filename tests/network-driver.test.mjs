/**
 * TCP:9100 delivery.
 *
 * Hatay Sofrası, 20.10.2026: a network printer in "E) Görüntü" mode printed
 * each ticket and closed its connection later than the 15 idle seconds the
 * agent allowed. The agent called that a failure, retried, and the kitchen got
 * the same ticket again and again. The printer now gets time to close; every
 * other outcome must stay exactly as it was — including on Windows, where the
 * OS accepts a whole ticket even from a printer that is not reading.
 *
 * Every test stops its fake printer in `finally`: one left listening keeps the
 * file alive until the runner's timeout.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { printOverNetwork } from '../dist/main/print/network-driver.js';
import { PrintEngine } from '../dist/main/print/engine.js';
import { isRetryable, NotRetryablePrintError } from '../dist/main/print/print-errors.js';
import { JobQueue } from '../dist/main/queue.js';

const FAST = { connectTimeoutMs: 500, writeTimeoutMs: 300, closeWaitMs: 3000 };

/** A fake printer; `onSocket` decides how it behaves. */
async function printer({ onSocket = (socket) => socket.resume(), allowHalfOpen = false } = {}) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen }, (socket) => {
    sockets.add(socket);
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => received.push(Buffer.concat(chunks)));
    socket.on('error', () => {});
    onSocket(socket);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    received,
    server,
    port: server.address().port,
    stop: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => (server.listening ? server.close(() => r()) : r()));
    },
  };
}

const ticket = Buffer.from('\x1b@MUTFAK\nIcli Kofte\n\x1dVB\x00', 'latin1');
const outcome = (promise) =>
  promise.then(
    () => ({ printed: true }),
    (err) => ({ printed: false, err }),
  );

async function withPrinter(options, fn) {
  const p = await printer(options);
  try {
    return await fn(p);
  } finally {
    await p.stop();
  }
}

test('a printer that closes normally: printed, as always', () =>
  withPrinter({}, async (p) => {
    await printOverNetwork('127.0.0.1', p.port, ticket, FAST);
    assert.deepEqual(p.received[0], ticket);
  }));

test('a printer that closes only after it has finished printing (slow, images): printed once', () =>
  // Closes 1 s after the whole ticket arrived — well past the write idle limit
  // (300 ms here, 15 s for real), which is what used to be called a failure.
  withPrinter(
    {
      allowHalfOpen: true,
      onSocket: (socket) => {
        socket.resume();
        socket.on('end', () => setTimeout(() => socket.end(), 1000));
      },
    },
    async (p) => {
      const result = await outcome(printOverNetwork('127.0.0.1', p.port, ticket, FAST));
      assert.equal(result.printed, true, result.err?.message);
      assert.deepEqual(p.received[0], ticket);
    },
  ));

/*
 * 12.11.2026 (Zjiang tipi): the whole ticket written and THEN no clean close —
 * a reset, or never closing. The ticket is usually on paper; a retry was a
 * second copy, then a third ten seconds later. It fails once, not retried, and
 * the message tells the kasa to reprint only if nothing came out.
 */
test('a printer that never closes after the whole ticket: fails once, NOT retried', () =>
  withPrinter({ allowHalfOpen: true }, async (p) => {
    const result = await outcome(printOverNetwork('127.0.0.1', p.port, ticket, { ...FAST, closeWaitMs: 500 }));
    assert.equal(result.printed, false);
    assert.equal(isRetryable(result.err), false);
    assert.match(result.err.message, /yeniden basın/);
  }));

test('a printer that reads the ticket then resets (Zjiang): fails once, NOT retried', () => {
  const seen = [];
  return withPrinter(
    {
      // Half-open: the printer does not answer our FIN, it resets later.
      allowHalfOpen: true,
      onSocket: (socket) => {
        socket.on('data', (chunk) => {
          seen.push(chunk);
          setTimeout(() => socket.resetAndDestroy(), 50);
        });
      },
    },
    async (p) => {
      const result = await outcome(printOverNetwork('127.0.0.1', p.port, ticket, FAST));
      assert.equal(result.printed, false);
      assert.equal(isRetryable(result.err), false);
      assert.deepEqual(Buffer.concat(seen), ticket);
    },
  );
});

test('queue + Zjiang-like printer: the ticket goes out ONCE and is acked failed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-queue-zj-'));
  let deliveries = 0;
  const p = await printer({
    allowHalfOpen: true,
    onSocket: (socket) => {
      socket.once('data', () => {
        deliveries += 1;
        setTimeout(() => socket.resetAndDestroy(), 50);
      });
    },
  });
  const acks = [];
  const q = new JobQueue(dir, (job) => printOverNetwork('127.0.0.1', p.port, Buffer.from(job.escpos, 'base64'), FAST));
  q.on('ack', (a) => acks.push(a));
  q.start();
  try {
    q.enqueue({ jobId: 'zj', station: 'CASHIER', copies: 1, escpos: ticket.toString('base64') });
    const started = Date.now();
    while (acks.length === 0 && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 2500)); // the old retries came at 1–2 s, then 2–4 s
    assert.equal(deliveries, 1, 'the bill reached the printer once');
    assert.equal(acks.length, 1);
    assert.equal(acks[0].status, 'failed');
    assert.equal(acks[0].attempts, 1);
  } finally {
    q.stop();
    await p.stop();
  }
});

test('nobody listening: still an error the queue retries (unchanged)', async () => {
  const p = await printer();
  const port = p.port;
  await p.stop();
  const result = await outcome(printOverNetwork('127.0.0.1', port, ticket, FAST));
  assert.equal(result.printed, false);
  assert.equal(isRetryable(result.err), true);
});

test('a printer that stops reading: an error; retried only while the ticket was not fully written', () =>
  // Linux/macOS stall the write: nothing complete reached the printer, retry.
  // Windows takes all 64 MB into its own buffers and reports it written: from
  // there a retry may be a second copy, so it fails once.
  withPrinter({ onSocket: (socket) => socket.pause() }, async (p) => {
    const huge = Buffer.alloc(64 * 1024 * 1024, 0x41);
    const result = await outcome(printOverNetwork('127.0.0.1', p.port, huge, { ...FAST, closeWaitMs: 500 }));
    assert.equal(result.printed, false);
    assert.equal(isRetryable(result.err), process.platform !== 'win32');
  }));

test('Windows spooler: a failure after WRITTEN is not retried; before it, it is', async () => {
  const { windowsSpoolerError } = await import('../dist/main/print/spooler-driver.js');
  const after = windowsSpoolerError('POS-80', Object.assign(new Error('Command failed: timeout'), { stdout: 'WRITTEN\r\n' }));
  assert.equal(isRetryable(after), false);
  assert.match(after.message, /POS-80/);
  const before = windowsSpoolerError('POS-80', Object.assign(new Error('OpenPrinter failed: 1801'), { stdout: '' }));
  assert.equal(isRetryable(before), true);
});

test('engine: a second copy that fails does not reprint the first', async () => {
  // The printer goes away after the first copy: the second cannot connect.
  let p;
  p = await printer({ onSocket: (socket) => (socket.resume(), p.server.close()) });
  try {
    const config = { target: { kind: 'network', host: '127.0.0.1', port: p.port }, codepage: 'CP857', width: 42, cut: true };
    const engine = new PrintEngine(() => ({ printer: config, label: 'Mutfak' }));
    const payload = Buffer.from('HELLO\n', 'latin1').toString('base64');
    const result = await outcome(engine.print({ jobId: 'c2', station: 'KITCHEN', copies: 2, escpos: payload }));
    assert.equal(result.printed, false);
    assert.equal(isRetryable(result.err), false);
    assert.equal(p.received.length, 1, 'the first copy is on paper');
  } finally {
    await p.stop();
  }
});

test('queue: a not-retryable failure is acked failed once, never printed again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-queue-nr-'));
  let attempts = 0;
  const acks = [];
  const q = new JobQueue(dir, async () => {
    attempts += 1;
    throw new NotRetryablePrintError('kısmen basıldı');
  });
  q.on('ack', (a) => acks.push(a));
  q.start();
  try {
    q.enqueue({ jobId: 'nr', station: 'KITCHEN', copies: 1, escpos: Buffer.from('x').toString('base64') });
    const started = Date.now();
    while (acks.length === 0 && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 1500)); // a retry would have run by now (backoff ≥ 1 s)
    assert.equal(attempts, 1);
    assert.equal(acks.length, 1);
    assert.equal(acks[0].status, 'failed');
  } finally {
    q.stop();
  }
});
