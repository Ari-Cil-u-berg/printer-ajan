import type { PrintJob, PrinterConfig } from '../../shared/types';
import { log } from '../logger';
import { EscPosBuilder, renderTicket } from './escpos';
import { calibrationBlock, serverStyleTestSlip, serverTicketBytes } from './server-escpos';
import { printOverNetwork, probeNetworkPrinter } from './network-driver';
import { printViaSpooler, probeSpoolerPrinter } from './spooler-driver';

export class PrinterNotConfiguredError extends Error {
  constructor(what: string) {
    super(`${what} için bu bilgisayarda yazıcı seçilmemiş`);
    this.name = 'PrinterNotConfiguredError';
  }
}

/**
 * Resolves the local printer for a job — by the pairing that delivered it, or
 * by station for a pairing migrated from ≤0.3.21 — and returns a label for the
 * error when there is none.
 */
export type PrinterResolver = (job: PrintJob) => { printer: PrinterConfig | undefined; label: string };

const TABLE_LABEL: Record<string, string> = {
  PC857_13: 'PC857 · 13',
  WPC1254_48: 'WPC1254 · 48',
  ASCII: 'Türkçe harfsiz',
};

function textTableLabel(printer: PrinterConfig): string {
  return TABLE_LABEL[printer.textTable ?? ''] ?? 'Varsayılan (WPC1254 · 91)';
}

export class PrintEngine {
  constructor(private readonly resolve: PrinterResolver) {}

  async print(job: PrintJob): Promise<void> {
    const { printer, label } = this.resolve(job);
    if (!printer) throw new PrinterNotConfiguredError(label);

    const bytes = this.renderJob(job, printer);
    const copies = Math.max(1, Math.min(job.copies || 1, 5));
    for (let i = 0; i < copies; i++) {
      await this.send(printer, bytes);
    }
    log.info('printed', { jobId: job.jobId, station: job.station, route: job.route, copies, bytes: bytes.length });
  }

  private renderJob(job: PrintJob, printer: PrinterConfig): Buffer {
    if (job.escpos) {
      const payload = Buffer.from(job.escpos, 'base64');
      // A server-chosen code page keeps the old prefix-only path untouched.
      if (job.codepage !== undefined) return Buffer.concat([this.legacyPrefix(printer, job.codepage), payload]);
      return serverTicketBytes(payload, printer, this.legacyPrefix(printer));
    }
    if (job.content) return renderTicket(job.content, printer, job.codepage);
    throw new Error(`İş içeriği boş (${job.jobId})`);
  }

  /** `heading` is what the test slip says it is for — "MUTFAK YAZICI" — so it can be matched to the panel. */
  async testPrint(printer: PrinterConfig | undefined, heading: string): Promise<void> {
    if (!printer) throw new PrinterNotConfiguredError(heading);
    const slip = serverTicketBytes(serverStyleTestSlip(heading, textTableLabel(printer)), printer, this.legacyPrefix(printer));
    await this.send(printer, Buffer.concat([slip, calibrationBlock(printer.width, printer.cut)]));
  }

  /**
   * `ESC @` + the agent's `codepage`, sent in front of server bytes since
   * before `textTable` existed. The server's own `ESC @` / `ESC t 91` override it,
   * so it changes nothing on paper — kept so an untouched config sends the very
   * same bytes it always has.
   */
  private legacyPrefix(printer: PrinterConfig, codepage = printer.codepage): Buffer {
    return new EscPosBuilder(codepage, printer.width).init().build();
  }

  private async send(printer: PrinterConfig, bytes: Buffer): Promise<void> {
    if (printer.target.kind === 'network') {
      await printOverNetwork(printer.target.host, printer.target.port, bytes);
    } else {
      await printViaSpooler(printer.target.printerName, bytes);
    }
  }

  async probe(printer: PrinterConfig | undefined): Promise<{ ok: boolean; error?: string }> {
    if (!printer) return { ok: false, error: 'Yazıcı seçilmemiş' };
    try {
      const ok =
        printer.target.kind === 'network'
          ? await probeNetworkPrinter(printer.target.host, printer.target.port)
          : await probeSpoolerPrinter(printer.target.printerName);
      return ok ? { ok } : { ok, error: 'Yazıcıya ulaşılamıyor' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
