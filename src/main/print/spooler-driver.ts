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

/**
 * Windows: USB'ye takılı, yazıcıya benzeyen ama Windows'ta yazıcı kuyruğu
 * olmayan cihazlar — "XP-80 takılı ama listede yok" sorusunun cevabı.
 *
 * Win32_Printer yalnızca sürücüsü kurulmuş kuyrukları görür. Sürücüsüz bir fiş
 * yazıcısı Aygıt Yöneticisi'nde ya hatalı/bilinmeyen USB cihazı ya da yalnızca
 * "USB Yazdırma Desteği" (USBPRINT) olarak durur. Onları adıyla gösterip
 * kullanıcıya "sürücüyü kur" demek için. Sezgisel: yanlış pozitif olabilir,
 * ekranda yalnızca ipucu olarak kullanılır, hiçbir şeye bağlanmaz.
 */
export interface UsbPrinterHint {
  name: string;
  /** false: Windows cihazı tanıyor ama sürücüsü yok ya da hatalı. */
  driverOk: boolean;
}

export async function listUnqueuedUsbPrinters(): Promise<UsbPrinterHint[]> {
  if (process.platform !== 'win32') return [];
  const script = [
    "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object {",
    "  $_.InstanceId -like 'USBPRINT\\*' -or",
    "  ($_.InstanceId -like 'USB\\*' -and ($_.Status -ne 'OK' -or $_.Class -eq 'Printer' -or $_.FriendlyName -match 'print|pos|thermal|receipt|xp-|xprinter'))",
    "} | ForEach-Object { \"$($_.Status)|$($_.FriendlyName)\" }",
  ].join(' ');
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
    );
    const seen = new Set<string>();
    const hints: UsbPrinterHint[] = [];
    for (const line of splitLines(stdout)) {
      const [status = '', ...rest] = line.split('|');
      const name = rest.join('|').trim() || 'Bilinmeyen USB cihazı';
      if (seen.has(name)) continue;
      seen.add(name);
      hints.push({ name, driverOk: status.trim() === 'OK' });
    }
    return hints;
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
