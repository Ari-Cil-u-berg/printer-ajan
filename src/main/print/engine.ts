import type { PrintJob, PrinterConfig, Station } from '../../shared/types';
import { log } from '../logger';
import { EscPosBuilder, renderTestTicket, renderTicket } from './escpos';
import { printOverNetwork, probeNetworkPrinter } from './network-driver';
import { printViaSpooler, probeSpoolerPrinter } from './spooler-driver';

export class PrinterNotConfiguredError extends Error {
  constructor(station: Station) {
    super(`${station} istasyonu için yazıcı seçilmemiş`);
    this.name = 'PrinterNotConfiguredError';
  }
}

export class PrintEngine {
  constructor(private readonly getPrinter: (station: Station) => PrinterConfig | undefined) {}

  async print(job: PrintJob): Promise<void> {
    const printer = this.getPrinter(job.station);
    if (!printer) throw new PrinterNotConfiguredError(job.station);

    const bytes = this.renderJob(job, printer);
    const copies = Math.max(1, Math.min(job.copies || 1, 5));
    for (let i = 0; i < copies; i++) {
      await this.send(printer, bytes);
    }
    log.info('printed', { jobId: job.jobId, station: job.station, copies, bytes: bytes.length });
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

  async testPrint(station: Station): Promise<void> {
    const printer = this.getPrinter(station);
    if (!printer) throw new PrinterNotConfiguredError(station);
    const heading = { BAR: 'BAR', KITCHEN: 'MUTFAK', CASHIER: 'KASA' }[station];
    await this.send(printer, renderTestTicket(printer, heading));
  }

  private async send(printer: PrinterConfig, bytes: Buffer): Promise<void> {
    if (printer.target.kind === 'network') {
      await printOverNetwork(printer.target.host, printer.target.port, bytes);
    } else {
      await printViaSpooler(printer.target.printerName, bytes);
    }
  }

  async probe(station: Station): Promise<{ ok: boolean; error?: string }> {
    const printer = this.getPrinter(station);
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
