import net from 'node:net';
import { log } from '../logger';

export interface NetworkPrintTimings {
  connectTimeoutMs: number;
  /** Idle limit after connecting — while writing, and while waiting for the close. */
  writeTimeoutMs: number;
}

const TIMINGS: NetworkPrintTimings = {
  connectTimeoutMs: 5000,
  writeTimeoutMs: 15000,
};

/**
 * Raw TCP:9100 (JetDirect). No driver, no native code — open socket, write ESC/POS bytes.
 * Resolves once the bytes are flushed and the socket closes cleanly.
 *
 * ONE EXCEPTION to "closes cleanly": every byte has been handed over and FIN
 * sent, and the printer simply has not closed within the idle limit. That is a
 * delivered ticket, not a failure. A printer drawing a ticket of images ("E)
 * Görüntü") closes when it has finished PRINTING, which can be later than any
 * timeout — and calling that a failure retried it, up to 20 times: the same
 * ticket again and again (Hatay Sofrası, 20.10.2026).
 *
 * Everything else is exactly as before, deliberately: a refused or reset
 * connection, or a write that never completes, is still an error the queue
 * retries — the printer may not have taken the ticket, and a retry is what
 * gets it onto paper.
 */
export function printOverNetwork(
  host: string,
  port: number,
  data: Buffer,
  timings: NetworkPrintTimings = TIMINGS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    let handedOff = false;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    socket.setTimeout(timings.connectTimeoutMs);
    socket.once('timeout', () => {
      if (handedOff) {
        log.warn('printer did not close after receiving the whole ticket — treated as printed', {
          host,
          port,
          bytes: data.length,
        });
        return done();
      }
      done(new Error(`Yazıcı yanıt vermiyor (${host}:${port})`));
    });
    socket.once('error', (err) => done(new Error(`Yazıcıya bağlanılamadı (${host}:${port}): ${err.message}`)));

    socket.connect(port, host, () => {
      socket.setTimeout(timings.writeTimeoutMs);
      socket.write(data, (err) => {
        if (err) return done(err);
        handedOff = true;
        // end() flushes; 'close' confirms the printer accepted the stream.
        socket.end();
      });
    });

    socket.once('close', () => done());
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
