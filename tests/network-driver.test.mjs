/**
 * TCP:9100 delivery.
 *
 * Hatay Sofrası, 20.10.2026: a network printer in "E) Görüntü" mode printed
 * each ticket and closed its connection late. The agent called that a failure,
 * retried, and the kitchen got the same ticket again and again. That one case
 * changed; every other outcome must stay exactly as it was (see the last tests).
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { printOverNetwork } from '../dist/main/print/network-driver.js';
import { PrintEngine } from '../dist/main/print/engine.js';
import { isRetryable } from '../dist/main/print/print-errors.js';
import { JobQueue } from '../dist/main/queue.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FAST = { connectTimeoutMs: 500, writeTimeoutMs: 300 };

/** A printer that reads everything; `onData` decides what it does after. */
async function printer({ onSocket = () => {}, allowHalfOpen = false } = {}) {
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

test('a printer that never closes after taking the ticket: delivered, not an error', async () => {
  // allowHalfOpen: our FIN arrives, the printer keeps its side open forever.
  const p = await printer({ allowHalfOpen: true });
  await printOverNetwork('127.0.0.1', p.port, ticket, FAST);
  assert.deepEqual(p.received[0], ticket);
  await p.stop();
});

test('a printer that closes normally: delivered, as always', async () => {
  const p = await printer();
  await printOverNetwork('127.0.0.1', p.port, ticket, FAST);
  assert.deepEqual(p.received[0], ticket);
  await p.stop();
});

test('a reset connection is still an error the queue retries (unchanged)', async () => {
  // Accepts, then resets without reading — the ticket may not be on paper.
  const p = await printer({ onSocket: (socket) => socket.resetAndDestroy() });
  try {
    const err = await printOverNetwork('127.0.0.1', p.port, ticket, FAST).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof Error);
    assert.match(err.message, /Yazıcıya bağlanılamadı/);
    assert.equal(isRetryable(err), true);
  } finally {
    await p.stop();
  }
});

test('nobody listening: fails, and the queue may retry (nothing reached paper)', async () => {
  const p = await printer();
  const port = p.port;
  await p.stop();
  const err = await printOverNetwork('127.0.0.1', port, ticket, FAST).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof Error);
  assert.equal(isRetryable(err), true);
});

test('a printer that stops reading mid-ticket: still an error the queue retries (unchanged)', async () => {
  const p = await printer({ onSocket: (socket) => socket.pause() });
  // Far more than the kernel buffers hold, so the write cannot complete.
  const huge = Buffer.alloc(64 * 1024 * 1024, 0x41);
  const err = await printOverNetwork('127.0.0.1', p.port, huge, FAST).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof Error);
  assert.match(err.message, /Yazıcı yanıt vermiyor/);
  assert.equal(isRetryable(err), true);
  await p.stop();
});

test('engine: a second copy that fails does not reprint the first', async () => {
  // The printer goes away after the first copy: the second cannot connect.
  let p;
  p = await printer({ onSocket: () => p.server.close() });
  try {
    const config = { target: { kind: 'network', host: '127.0.0.1', port: p.port }, codepage: 'CP857', width: 42, cut: true };
    const engine = new PrintEngine(() => ({ printer: config, label: 'Mutfak' }));
    const payload = Buffer.from('HELLO\n', 'latin1').toString('base64');
    const err = await engine.print({ jobId: 'c2', station: 'KITCHEN', copies: 2, escpos: payload }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof Error);
    assert.equal(isRetryable(err), false);
    assert.equal(p.received.length, 1, 'the first copy is on paper');
  } finally {
    await p.stop();
  }
});

test('queue: a not-retryable failure is acked failed once, never printed again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-queue-nr-'));
  let attempts = 0;
  const acks = [];
  const { NotRetryablePrintError } = await import('../dist/main/print/print-errors.js');
  const q = new JobQueue(dir, async () => {
    attempts += 1;
    throw new NotRetryablePrintError('kısmen basıldı');
  });
  q.on('ack', (a) => acks.push(a));
  q.start();
  q.enqueue({ jobId: 'nr', station: 'KITCHEN', copies: 1, escpos: Buffer.from('x').toString('base64') });

  const started = Date.now();
  while (acks.length === 0 && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 1500)); // a retry would have run by now (backoff ≥ 1 s)
  assert.equal(attempts, 1);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].status, 'failed');
  q.stop();
});
