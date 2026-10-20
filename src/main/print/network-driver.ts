import net from 'node:net';
import { log } from '../logger';
import { NotRetryablePrintError } from './print-errors';

export interface NetworkPrintTimings {
  /** Nothing has reached the printer yet: failing here is safe to retry. */
  connectTimeoutMs: number;
  /** Idle limit while the bytes are still on their way to the printer. */
  writeTimeoutMs: number;
  /** How long to wait for the printer to close once it has every byte. */
  closeWaitMs: number;
}

const TIMINGS: NetworkPrintTimings = {
  connectTimeoutMs: 5000,
  writeTimeoutMs: 15000,
  closeWaitMs: 30000,
};

/**
 * Raw TCP:9100 (JetDirect). No driver, no native code — open socket, write ESC/POS bytes.
 *
 * THREE PHASES, because only the first one is safe to retry:
 *   1. Connecting. Nothing has reached the printer; an error or a timeout
 *      rejects with a plain Error and the queue tries again later.
 *   2. Writing. The printer accepted the connection and is taking bytes; part
 *      of the ticket may already be on paper. A failure rejects with
 *      `NotRetryablePrintError` — the kasa reprints it by hand, once.
 *   3. Handed off. Every byte is with the printer (the write callback fired)
 *      and we have sent FIN. Its closing the connection is courtesy, not
 *      proof: a printer drawing a ticket of images closes when it is done
 *      printing, which can be later than any timeout, and some never close or
 *      reset instead. Late, reset or never — the ticket is delivered.
 *
 * Phase 3 used to be an error after 15 idle seconds. That turned every slow
 * print into a retry and every retry into another copy of the same ticket
 * (Hatay Sofrası, 20.10.2026, "E) Görüntü").
 */
export function printOverNetwork(
  host: string,
  port: number,
  data: Buffer,
  timings: NetworkPrintTimings = TIMINGS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let phase: 'connecting' | 'writing' | 'handedOff' = 'connecting';
    let settled = false;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    /** A timeout or error: what it means depends on how far the ticket got. */
    const fail = (reason: string) => {
      if (phase === 'connecting') return done(new Error(`Yazıcıya bağlanılamadı (${host}:${port}): ${reason}`));
      if (phase === 'writing') {
        return done(
          new NotRetryablePrintError(
            `Fiş yazıcıya giderken kesildi (${host}:${port}): ${reason} — kısmen basılmış olabilir, yeniden basılmadı`,
          ),
        );
      }
      log.warn('printer did not close cleanly after receiving the ticket — treated as printed', {
        host,
        port,
        reason,
        bytes: data.length,
      });
      done();
    };

    socket.setTimeout(timings.connectTimeoutMs);
    socket.on('timeout', () => fail(phase === 'connecting' ? 'yanıt vermiyor' : 'zaman aşımı'));
    socket.on('error', (err) => fail(err.message));

    socket.connect(port, host, () => {
      phase = 'writing';
      socket.setTimeout(timings.writeTimeoutMs);
      socket.write(data, (err) => {
        if (err) return fail(err.message);
        phase = 'handedOff';
        socket.setTimeout(timings.closeWaitMs);
        socket.end();
      });
    });

    socket.once('close', () => {
      if (phase === 'handedOff') return done();
      // Closed before every byte was written: a reset with no 'error', or a
      // printer that hung up mid-ticket.
      fail('bağlantı kapandı');
    });
  });
}

/** Cheap reachability probe for the status panel. */
export function probeNetworkPrinter(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host, () => finish(true));
  });
}
