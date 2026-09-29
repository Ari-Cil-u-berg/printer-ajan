import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JobQueue, laneOf } from '../dist/main/queue.js';

/**
 * One agent, several printer records, each paired with its own code. Up to
 * 0.3.21 a till with a kasa and a mutfak printer could only hold one code, so
 * the other printer's tickets never arrived. These pin the lanes: each pairing
 * drains on its own, even two printers on the same station.
 */

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ari-pairings-'));
const job = (jobId, station, route) => ({
  jobId,
  station,
  copies: 1,
  escpos: Buffer.from('x').toString('base64'),
  ...(route ? { route } : {}),
});

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('a job lanes by its pairing, and by station only when it has none', () => {
  assert.equal(laneOf(job('a', 'KITCHEN', 'dev-hot')), 'dev-hot');
  assert.equal(laneOf(job('b', 'KITCHEN')), 'KITCHEN');
});

test('two printers on the same station drain independently — a stuck one does not block the other', async () => {
  const printed = [];
  const q = new JobQueue(tmpDir(), async (j) => {
    if (j.route === 'dev-hot') throw new Error('kağıt yok');
    printed.push(j.jobId);
  });
  q.start();
  q.enqueue(job('hot-1', 'KITCHEN', 'dev-hot'));
  q.enqueue(job('cold-1', 'KITCHEN', 'dev-cold'));
  q.enqueue(job('cold-2', 'KITCHEN', 'dev-cold'));
  await waitFor(() => printed.length === 2);
  assert.deepEqual(printed, ['cold-1', 'cold-2']);
  q.stop();
});

test('the ack carries its job, so it goes back on the socket that delivered it', async () => {
  const acks = [];
  const q = new JobQueue(tmpDir(), async () => {});
  q.on('ack', (ack, j) => acks.push({ jobId: ack.jobId, route: j?.route }));
  q.start();
  q.enqueue(job('k1', 'CASHIER', 'dev-kasa'));
  q.enqueue(job('m1', 'KITCHEN', 'dev-mutfak'));
  await waitFor(() => acks.length === 2);
  assert.deepEqual(
    acks.sort((a, b) => a.jobId.localeCompare(b.jobId)),
    [
      { jobId: 'k1', route: 'dev-kasa' },
      { jobId: 'm1', route: 'dev-mutfak' },
    ],
  );
  q.stop();
});

test('a redelivered duplicate is acked with its job too', async () => {
  const acks = [];
  const q = new JobQueue(tmpDir(), async () => {});
  q.on('ack', (ack, j) => acks.push(j?.route));
  q.start();
  q.enqueue(job('d1', 'BAR', 'dev-bar'));
  await waitFor(() => acks.length === 1);
  q.enqueue(job('d1', 'BAR', 'dev-bar'));
  await waitFor(() => acks.length === 2);
  assert.deepEqual(acks, ['dev-bar', 'dev-bar']);
  q.stop();
});
