import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { STATIONS } from '../shared/types';
import type { JobAck, PrintJob, Station } from '../shared/types';
import { atomicWrite } from './fsutil';
import { log } from './logger';

interface QueueEntry {
  job: PrintJob;
  attempts: number;
  nextAttemptAt: number;
  receivedAt: number;
}

interface QueueFile {
  version: 1;
  entries: QueueEntry[];
  /** jobIds already printed — idempotency guard against redelivery. */
  done: { jobId: string; at: number }[];
}

const DONE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_DONE = 2000;
const MAX_ATTEMPTS = 20;

/** Exponential backoff with jitter, capped at 1 min — a printer that is out of paper
 *  should be retried often enough that the ticket appears the moment it is fixed. */
function backoffMs(attempts: number): number {
  const base = Math.min(1000 * 2 ** (attempts - 1), 60_000);
  return base + Math.random() * Math.min(base, 5000);
}

/**
 * The lane a job waits in. One lane per pairing (printer record), so two
 * printers on the same station drain independently and in their own order;
 * jobs queued before pairings existed keep their station lane.
 */
export function laneOf(job: PrintJob): string {
  return job.route ?? job.station;
}

export interface JobQueueEvents {
  /** The job rides along so the caller can send the ack on the right socket. */
  ack: (ack: JobAck, job: PrintJob) => void;
  changed: () => void;
  failure: (job: PrintJob, error: string) => void;
}

/**
 * Durable, per-station FIFO queue. Jobs are persisted *before* printing, so a crash
 * or restart never loses a ticket, and each jobId prints exactly once.
 */
export class JobQueue extends EventEmitter {
  private readonly file: string;
  private state: QueueFile;
  private readonly running = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    dir: string,
    private readonly printJob: (job: PrintJob) => Promise<void>,
  ) {
    super();
    this.file = path.join(dir, 'queue.json');
    this.state = this.load();
  }

  private load(): QueueFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as QueueFile;
      if (parsed.version === 1 && Array.isArray(parsed.entries)) {
        // Anything that was mid-flight when we died is retried immediately.
        for (const e of parsed.entries) e.nextAttemptAt = 0;
        return { version: 1, entries: parsed.entries, done: parsed.done ?? [] };
      }
    } catch {
      /* fresh queue */
    }
    return { version: 1, entries: [], done: [] };
  }

  private persist(): void {
    const cutoff = Date.now() - DONE_RETENTION_MS;
    this.state.done = this.state.done.filter((d) => d.at > cutoff).slice(-MAX_DONE);
    atomicWrite(this.file, JSON.stringify(this.state));
    this.emit('changed');
  }

  /** Returns false when the job was a duplicate (already queued or already printed). */
  enqueue(job: PrintJob): boolean {
    if (this.state.done.some((d) => d.jobId === job.jobId)) {
      log.info('duplicate job ignored (already printed)', { jobId: job.jobId });
      this.emit('ack', { jobId: job.jobId, status: 'printed', attempts: 0 }, job);
      return false;
    }
    if (this.state.entries.some((e) => e.job.jobId === job.jobId)) {
      log.info('duplicate job ignored (already queued)', { jobId: job.jobId });
      return false;
    }
    this.state.entries.push({ job, attempts: 0, nextAttemptAt: 0, receivedAt: Date.now() });
    this.persist();
    this.pump(laneOf(job));
    return true;
  }

  size(): number {
    return this.state.entries.length;
  }

  pending(station: Station): number {
    return this.state.entries.filter((e) => e.job.station === station).length;
  }

  /** Kick every lane — call on reconnect and after a printer setting changes. */
  pumpAll(): void {
    const lanes = new Set<string>(STATIONS);
    for (const entry of this.state.entries) lanes.add(laneOf(entry.job));
    for (const lane of lanes) this.pump(lane);
  }

  start(): void {
    this.stopped = false;
    this.pumpAll();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(lane: string, delay: number): void {
    const existing = this.timers.get(lane);
    if (existing) clearTimeout(existing);
    this.timers.set(
      lane,
      setTimeout(() => {
        this.timers.delete(lane);
        this.pump(lane);
      }, delay),
    );
  }

  /** One worker per lane keeps tickets in receive order within that printer. */
  private async pump(lane: string): Promise<void> {
    if (this.stopped || this.running.has(lane)) return;
    this.running.add(lane);
    try {
      for (;;) {
        const head = this.state.entries.find((e) => laneOf(e.job) === lane);
        if (!head) return;

        const wait = head.nextAttemptAt - Date.now();
        if (wait > 0) {
          this.schedule(lane, wait);
          return;
        }

        head.attempts += 1;
        try {
          await this.printJob(head.job);
          this.remove(head.job.jobId);
          this.state.done.push({ jobId: head.job.jobId, at: Date.now() });
          this.persist();
          this.emit('ack', { jobId: head.job.jobId, status: 'printed', attempts: head.attempts }, head.job);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          log.warn('print failed', { jobId: head.job.jobId, attempts: head.attempts, error });
          this.emit('failure', head.job, error);

          if (head.attempts >= MAX_ATTEMPTS) {
            this.remove(head.job.jobId);
            this.state.done.push({ jobId: head.job.jobId, at: Date.now() });
            this.persist();
            this.emit('ack', { jobId: head.job.jobId, status: 'failed', error, attempts: head.attempts }, head.job);
            continue; // head-of-line job given up on; move to the next ticket
          }

          const delay = backoffMs(head.attempts);
          head.nextAttemptAt = Date.now() + delay;
          this.persist();
          this.schedule(lane, delay);
          return;
        }
      }
    } finally {
      this.running.delete(lane);
    }
  }

  private remove(jobId: string): void {
    this.state.entries = this.state.entries.filter((e) => e.job.jobId !== jobId);
  }

  clear(): void {
    this.state.entries = [];
    this.persist();
  }
}
