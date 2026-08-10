import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LogEntry, LogLevel } from '../shared/types';
import { envConfig } from './env';

const MAX_BYTES = 2 * 1024 * 1024;
/** How many lines the in-app viewer can scroll back through. */
const BUFFER_SIZE = 1000;
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let stream: fs.WriteStream | null = null;
let logPath = '';
let packaged = false;
let seq = 0;

const buffer: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

/** Electron is required lazily so this module also loads under plain node (tests). */
function logDir(): string {
  try {
    const { app } = require('electron') as typeof import('electron');
    packaged = app.isPackaged;
    return app.getPath('logs');
  } catch {
    return path.join(os.tmpdir(), 'ari-adisyon-ajan');
  }
}

/** Dev and prod runs keep separate files so a debug session can't bury real incidents. */
function logFileName(): string {
  const { env } = envConfig();
  return env === 'production' ? 'agent.log' : `agent-${env}.log`;
}

function ensureStream(): fs.WriteStream {
  if (stream) return stream;
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  logPath = path.join(dir, logFileName());
  try {
    if (fs.statSync(logPath).size > MAX_BYTES) fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    /* no existing log */
  }
  stream = fs.createWriteStream(logPath, { flags: 'a' });
  return stream;
}

/** Never log tokens or pairing codes — redact anything that looks like one. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/(token|code|authorization)"?\s*[:=]\s*"?(bearer\s+)?[\w.\-]+/gi, '$1=***')
      .replace(/\bbearer\s+[\w.\-]+/gi, 'Bearer ***');
  }
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /token|code|secret|password/i.test(k) ? '***' : redact(v);
    }
    return out;
  }
  return value;
}

function format(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? redact(a) : JSON.stringify(redact(a))))
    .join(' ');
}

function write(level: LogLevel, args: unknown[]): void {
  const cfg = envConfig();
  if (ORDER[level] < ORDER[cfg.logLevel]) return;

  const entry: LogEntry = { id: ++seq, at: new Date().toISOString(), level, message: format(args) };

  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) buffer.splice(0, buffer.length - BUFFER_SIZE);
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* a broken listener must never break logging */
    }
  }

  const line = `${entry.at} [${level}] ${entry.message}\n`;
  try {
    ensureStream().write(line);
    if (cfg.logToConsole || !packaged) process.stdout.write(line);
  } catch {
    /* logging must never throw */
  }
}

export const log = {
  debug: (...args: unknown[]) => write('debug', args),
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
  path: () => logPath || path.join(logDir(), logFileName()),
  dir: () => logDir(),

  /** Buffered lines for the in-app viewer, oldest first. */
  entries: (): LogEntry[] => buffer.slice(),

  /** Clears the in-app buffer only — the file on disk is the audit trail. */
  clear: (): void => {
    buffer.length = 0;
  },

  subscribe(fn: (entry: LogEntry) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
