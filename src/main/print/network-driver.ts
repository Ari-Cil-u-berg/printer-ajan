import net from 'node:net';

import { NotRetryablePrintError } from './print-errors';

export interface NetworkPrintTimings {
  connectTimeoutMs: number;
  /** Idle limit while the bytes are still being written. */
  writeTimeoutMs: number;
  /** How long the printer may take to close once it has the whole ticket. */
  closeWaitMs: number;
}

const TIMINGS: NetworkPrintTimings = {
  connectTimeoutMs: 5000,
  writeTimeoutMs: 15000,
  closeWaitMs: 120000,
};

/**
 * Raw TCP:9100 (JetDirect). No driver, no native code — open socket, write ESC/POS bytes.
 * Resolves once the bytes are flushed and the socket closes cleanly.
 *
 * THE CLOSE IS GIVEN TIME. A printer closes the connection when it has
 * finished with the stream, and a ticket drawn as images ("E) Görüntü") can
 * take longer to print than the 15 idle seconds this used to allow. Treating
 * that as a failure retried a ticket that WAS printing — up to 20 times: the
 * same ticket again and again (Hatay Sofrası, 20.10.2026). So once every byte
 * is written the printer gets `closeWaitMs` to close.
 *
 * AFTER THE WHOLE TICKET IS WRITTEN, A FAILURE IS NOT RETRIED (12.11.2026).
 * Zjiang-type printers often print the ticket and then drop the connection
 * (reset) or never close it. That used to be a retryable error: the queue
 * sent the whole ticket again after 1, 2, 4, 8… seconds, up to 20 times — the
 * bill came out once, then again ten seconds later, sometimes many times.
 * "Written" does not prove paper either way (the OS takes the bytes, on
 * Windows even from a printer that is not reading), so the job fails ONCE,
 * visibly, with a message saying so; the kasa reprints it by hand if nothing
 * came out. A second copy is never sent on its own. A failure BEFORE the
 * ticket is fully written (cannot connect, refused, write stalls) still
 * retries — nothing of it can be on paper.
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
    /** Every byte handed to the OS: from here on a retry could be a second copy. */
    let written = false;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (!err) return resolve();
      reject(
        written
          ? new NotRetryablePrintError(
              `Fiş yazıcıya gönderildi ama yazıcı bağlantıyı düzgün kapatmadı (${host}:${port}): ${err.message}. ` +
                'Kâğıda çıkmadıysa kasadan yeniden basın.',
            )
          : err,
      );
    };

    socket.setTimeout(timings.connectTimeoutMs);
    socket.once('timeout', () => done(new Error(`Yazıcı yanıt vermiyor (${host}:${port})`)));
    socket.once('error', (err) => done(new Error(`Yazıcıya bağlanılamadı (${host}:${port}): ${err.message}`)));

    socket.connect(port, host, () => {
      socket.setTimeout(timings.writeTimeoutMs);
      socket.write(data, (err) => {
        if (err) return done(err);
        written = true;
        socket.setTimeout(timings.closeWaitMs);
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
