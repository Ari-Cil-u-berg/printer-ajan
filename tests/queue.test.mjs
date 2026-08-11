import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JobQueue } from '../dist/main/queue.js';
import { STATIONS } from '../dist/shared/types.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ari-queue-'));
}

const job = (jobId, station = 'BAR') => ({ jobId, station, copies: 1, escpos: Buffer.from('x').toString('base64') });

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('prints queued jobs and acks each once', async () => {
  const dir = tmpDir();
  const printed = [];
  const acks = [];
  const q = new JobQueue(dir, async (j) => { printed.push(j.jobId); });
  q.on('ack', (a) => acks.push(a));
  q.start();

  q.enqueue(job('a'));
  q.enqueue(job('b'));
  await waitFor(() => acks.length === 2);

  assert.deepEqual(printed, ['a', 'b']);
  assert.ok(acks.every((a) => a.status === 'printed'));
  q.stop();
});

test('preserves FIFO order within a station', async () => {
  const dir = tmpDir();
  const printed = [];
  const q = new JobQueue(dir, async (j) => {
    await new Promise((r) => setTimeout(r, 5));
    printed.push(j.jobId);
  });
  q.start();
  for (const id of ['1', '2', '3', '4']) q.enqueue(job(id));
  await waitFor(() => printed.length === 4);
  assert.deepEqual(printed, ['1', '2', '3', '4']);
  q.stop();
});

test('stations drain independently — a stuck BAR printer does not block KITCHEN', async () => {
  const dir = tmpDir();
  const printed = [];
  let barFails = true;
  const q = new JobQueue(dir, async (j) => {
    if (j.station === 'BAR' && barFails) throw new Error('bar offline');
    printed.push(j.jobId);
  });
  q.start();
  q.enqueue(job('bar-1', 'BAR'));
  q.enqueue(job('kitchen-1', 'KITCHEN'));

  await waitFor(() => printed.includes('kitchen-1'));
  assert.ok(!printed.includes('bar-1'));

  barFails = false;
  await waitFor(() => printed.includes('bar-1'), 8000);
  q.stop();
});

test('redelivered jobId is not printed twice', async () => {
  const dir = tmpDir();
  const printed = [];
  const acks = [];
  const q = new JobQueue(dir, async (j) => { printed.push(j.jobId); });
  q.on('ack', (a) => acks.push(a));
  q.start();

  q.enqueue(job('dup'));
  await waitFor(() => acks.length === 1);
  const accepted = q.enqueue(job('dup'));

  assert.equal(accepted, false);
  assert.deepEqual(printed, ['dup']);
  await waitFor(() => acks.length === 2); // re-acked so the backend stops resending
  q.stop();
});

test('a job persisted before a crash is retried on restart', async () => {
  const dir = tmpDir();
  const first = new JobQueue(dir, async () => { throw new Error('printer offline'); });
  first.start();
  first.enqueue(job('survivor'));
  await waitFor(() => fs.existsSync(path.join(dir, 'queue.json')));
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8')).entries.length === 1);
  first.stop();

  const printed = [];
  const second = new JobQueue(dir, async (j) => { printed.push(j.jobId); });
  second.start();
  await waitFor(() => printed.includes('survivor'));
  second.stop();
});

test('a queued job resumes after restart for every station, cashier included', async () => {
  // `start()` pumps one worker per station off the shared STATIONS list. When
  // that list was a second, shorter copy, a cashier ticket waiting on a printer
  // that had come back was never picked up again — it just sat in queue.json.
  for (const station of STATIONS) {
    const dir = tmpDir();
    const first = new JobQueue(dir, async () => { throw new Error('printer offline'); });
    first.start();
    first.enqueue(job(`survivor-${station}`, station));
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8')).entries.length === 1);
    first.stop();

    const printed = [];
    const second = new JobQueue(dir, async (j) => { printed.push(j.jobId); });
    second.start();
    await waitFor(() => printed.includes(`survivor-${station}`));
    second.stop();
  }
});

test('retries a failing printer with backoff, then succeeds', async () => {
  const dir = tmpDir();
  let attempts = 0;
  const acks = [];
  const q = new JobQueue(dir, async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('kağıt yok');
  });
  q.on('ack', (a) => acks.push(a));
  q.start();
  q.enqueue(job('retry'));

  await waitFor(() => acks.length === 1, 15000);
  assert.equal(acks[0].status, 'printed');
  assert.equal(acks[0].attempts, 3);
  q.stop();
});
