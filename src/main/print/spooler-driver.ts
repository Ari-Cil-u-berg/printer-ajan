import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { assetPath } from '../assets';

const run = promisify(execFile);
const EXEC_TIMEOUT_MS = 20000;

/**
 * USB / locally-installed printers: hand the raw ESC/POS bytes to the OS queue and
 * let the installed driver own the transport. No raw-USB code in the agent.
 *   macOS   → lp -o raw
 *   Windows → winspool RAW datatype via PowerShell P/Invoke (see raw-print.ps1)
 */
export async function printViaSpooler(printerName: string, data: Buffer): Promise<void> {
  const tmp = path.join(os.tmpdir(), `ari-fis-${crypto.randomUUID()}.bin`);
  await fs.writeFile(tmp, data);
  try {
    if (process.platform === 'win32') {
      await printWindows(printerName, tmp);
    } else {
      await printCups(printerName, tmp);
    }
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function printCups(printerName: string, file: string): Promise<void> {
  try {
    await run('lp', ['-d', printerName, '-o', 'raw', file], { timeout: EXEC_TIMEOUT_MS });
  } catch (err) {
    throw new Error(`Yazdırma kuyruğu hatası (${printerName}): ${message(err)}`);
  }
}

async function printWindows(printerName: string, file: string): Promise<void> {
  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', assetPath('raw-print.ps1'),
        '-PrinterName', printerName,
        '-FilePath', file,
      ],
      { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
    );
    if (!stdout.includes('OK')) throw new Error(stdout.trim() || 'bilinmeyen hata');
  } catch (err) {
    throw new Error(`Yazdırma kuyruğu hatası (${printerName}): ${message(err)}`);
  }
}

/** Names of printers installed in the OS, for the station dropdowns. */
export async function listSpoolerPrinters(): Promise<string[]> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-Command', 'Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name',
        ],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
      );
      return splitLines(stdout);
    }
    // `lpstat -e` lists every destination, including ones that are currently down.
    const { stdout } = await run('lpstat', ['-e'], { timeout: EXEC_TIMEOUT_MS });
    return splitLines(stdout);
  } catch {
    return [];
  }
}

/** True when the queue exists and is accepting jobs. */
export async function probeSpoolerPrinter(printerName: string): Promise<boolean> {
  const printers = await listSpoolerPrinters();
  return printers.includes(printerName);
}

function splitLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function message(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; message?: string };
    return (e.stderr?.trim() || e.message || String(err)).slice(0, 300);
  }
  return String(err);
}
