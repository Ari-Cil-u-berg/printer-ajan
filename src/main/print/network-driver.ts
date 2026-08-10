import net from 'node:net';

const CONNECT_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 15000;

/**
 * Raw TCP:9100 (JetDirect). No driver, no native code — open socket, write ESC/POS bytes.
 * Resolves once the bytes are flushed and the socket closes cleanly.
 */
export function printOverNetwork(host: string, port: number, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('timeout', () => done(new Error(`Yazıcı yanıt vermiyor (${host}:${port})`)));
    socket.once('error', (err) => done(new Error(`Yazıcıya bağlanılamadı (${host}:${port}): ${err.message}`)));

    socket.connect(port, host, () => {
      socket.setTimeout(WRITE_TIMEOUT_MS);
      socket.write(data, (err) => {
        if (err) return done(err);
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
