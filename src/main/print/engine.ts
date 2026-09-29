import type { PrintJob, PrinterConfig } from '../../shared/types';
import { log } from '../logger';
import { EscPosBuilder, renderTestTicket, renderTicket } from './escpos';
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
      // Backend-rendered bytes: still prepend the per-printer code page selection so
      // the same payload prints correctly on printers configured differently.
      const prefix = new EscPosBuilder(job.codepage ?? printer.codepage, printer.width).init().build();
      return Buffer.concat([prefix, Buffer.from(job.escpos, 'base64')]);
    }
    if (job.content) return renderTicket(job.content, printer, job.codepage);
    throw new Error(`İş içeriği boş (${job.jobId})`);
  }

  /** `heading` is what the test slip says it is for — "MUTFAK YAZICI" — so it can be matched to the panel. */
  async testPrint(printer: PrinterConfig | undefined, heading: string): Promise<void> {
    if (!printer) throw new PrinterNotConfiguredError(heading);
    await this.send(printer, renderTestTicket(printer, heading));
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
