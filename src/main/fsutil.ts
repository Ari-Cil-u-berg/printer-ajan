import fs from 'node:fs';

/**
 * Write-then-rename with an fsync: a crash mid-write leaves the previous file
 * intact instead of a truncated one. Used for every durable file (config, queue,
 * ack outbox) — a corrupt queue would mean lost tickets.
 */
export function atomicWrite(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
