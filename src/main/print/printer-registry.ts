import os from 'node:os';
import { probeNetworkPrinter } from './network-driver';
import { listSpoolerPrinters } from './spooler-driver';

export interface DiscoveredPrinter {
  kind: 'spooler' | 'network';
  label: string;
  printerName?: string;
  host?: string;
  port?: number;
}

export async function listPrinters(): Promise<DiscoveredPrinter[]> {
  const names = await listSpoolerPrinters();
  return names.map((printerName) => ({ kind: 'spooler' as const, label: printerName, printerName }));
}

/**
 * Sweeps the machine's own /24 for open :9100. Bounded concurrency and a short
 * timeout keep it under ~4s on a café LAN. Manual IP entry stays available.
 */
export async function scanNetworkPrinters(port = 9100, timeoutMs = 400): Promise<DiscoveredPrinter[]> {
  const hosts = localSubnetHosts();
  const found: DiscoveredPrinter[] = [];
  const CONCURRENCY = 64;

  for (let i = 0; i < hosts.length; i += CONCURRENCY) {
    const batch = hosts.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (host) => ((await probeNetworkPrinter(host, port, timeoutMs)) ? host : null)),
    );
    for (const host of results) {
      if (host) found.push({ kind: 'network', label: `${host}:${port}`, host, port });
    }
  }
  return found;
}

function localSubnetHosts(): string[] {
  const hosts: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const parts = addr.address.split('.');
      // Only /24-or-narrower nets; a wider mask would mean thousands of probes.
      if (addr.netmask !== '255.255.255.0') continue;
      const prefix = parts.slice(0, 3).join('.');
      const self = Number(parts[3]);
      for (let n = 1; n < 255; n++) {
        if (n !== self) hosts.push(`${prefix}.${n}`);
      }
    }
  }
  return hosts;
}
