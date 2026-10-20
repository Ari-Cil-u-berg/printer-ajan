import net from 'node:net';

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
 * A printer that still has not closed by then is an error, exactly as before:
 * "written" only means the operating system took the bytes — on Windows even
 * with the printer not reading at all — so it is no proof of paper, and a
 * retry is what gets a stuck printer's ticket printed once it recovers.
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

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    socket.setTimeout(timings.connectTimeoutMs);
    socket.once('timeout', () => done(new Error(`Yazıcı yanıt vermiyor (${host}:${port})`)));
    socket.once('error', (err) => done(new Error(`Yazıcıya bağlanılamadı (${host}:${port}): ${err.message}`)));

    socket.connect(port, host, () => {
      socket.setTimeout(timings.writeTimeoutMs);
      socket.write(data, (err) => {
        if (err) return done(err);
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
