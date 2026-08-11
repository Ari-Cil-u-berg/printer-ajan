import { BrowserWindow, ipcMain, shell } from 'electron';
import { isStation } from '../shared/types';
import type { LogEntry, PrinterConfig, Station } from '../shared/types';
import type { Agent } from './agent';
import { envConfig } from './env';
import { log } from './logger';
import { listPrinters, scanNetworkPrinters } from './print/printer-registry';
import { checkForUpdatesNow } from './updater';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function guard<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn('ipc error', { error });
    return { ok: false, error };
  }
}

/** C0 controls and DEL — never part of a printer name, always part of a probe. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function assertStation(value: unknown): Station {
  if (isStation(value)) return value;
  throw new Error('Geçersiz istasyon');
}

function assertPrinter(value: unknown): PrinterConfig {
  const p = value as PrinterConfig;
  if (!p || typeof p !== 'object') throw new Error('Geçersiz yazıcı ayarı');
  if (p.target?.kind === 'network') {
    if (!/^[\w.\-]+$/.test(p.target.host)) throw new Error('Geçersiz IP adresi');
    if (!Number.isInteger(p.target.port) || p.target.port < 1 || p.target.port > 65535) {
      throw new Error('Geçersiz port');
    }
  } else if (p.target?.kind === 'spooler') {
    const name = p.target.printerName;
    if (!name) throw new Error('Yazıcı seçilmedi');
    // The name is handed to `lp` / `powershell.exe` as an argv entry, never
    // through a shell — but control characters and absurd lengths have no
    // legitimate use here and would only ever be someone probing the edge.
    // Spaces stay legal: "EPSON TM-T20III Receipt" is what a real driver installs.
    if (typeof name !== 'string' || name.length > 200 || hasControlChars(name)) {
      throw new Error('Geçersiz yazıcı adı');
    }
  } else {
    throw new Error('Geçersiz yazıcı türü');
  }
  return {
    target: p.target,
    codepage: typeof p.codepage === 'string' ? p.codepage : 'CP857',
    width: ([32, 42, 48] as const).includes(p.width) ? p.width : 42,
    cut: p.cut !== false,
  };
}

export function registerIpc(agent: Agent, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('status:get', () => agent.status());

  ipcMain.handle('pair', (_e, code: unknown) =>
    guard(async () => {
      if (typeof code !== 'string') throw new Error('Geçersiz kod');
      await agent.pairWithCode(code);
      return agent.status();
    }),
  );

  ipcMain.handle('unpair', () => guard(() => { agent.unpair(); return agent.status(); }));

  ipcMain.handle('printers:list', () => guard(() => listPrinters()));
  ipcMain.handle('printers:scan', () => guard(() => scanNetworkPrinters()));

  ipcMain.handle('printers:set', (_e, station: unknown, printer: unknown) =>
    guard(() => {
      agent.setPrinter(assertStation(station), printer === null ? undefined : assertPrinter(printer));
      return agent.status();
    }),
  );

  ipcMain.handle('printers:test', (_e, station: unknown) =>
    guard(async () => {
      await agent.testPrint(assertStation(station));
      return true;
    }),
  );

  ipcMain.handle('printers:probe', () => guard(async () => { await agent.refreshPrinterHealth(); return agent.status(); }));

  ipcMain.handle('settings:autostart', (_e, enabled: unknown) =>
    guard(() => { agent.setAutostartEnabled(Boolean(enabled)); return agent.status(); }),
  );

  ipcMain.handle('settings:deviceName', (_e, name: unknown) =>
    guard(() => { agent.setDeviceName(String(name ?? '')); return agent.status(); }),
  );

  ipcMain.handle('app:checkUpdates', () => guard(() => { checkForUpdatesNow(); return true; }));
  ipcMain.handle('app:openLog', () => guard(() => shell.openPath(log.path())));
  ipcMain.handle('app:openLogFolder', () => guard(() => { shell.showItemInFolder(log.path()); return true; }));
  ipcMain.handle('app:env', () => envConfig());
  ipcMain.handle('app:hide', () => { getWindow()?.hide(); });

  ipcMain.handle('logs:get', () => log.entries());
  ipcMain.handle('logs:clear', () => guard(() => { log.clear(); return true; }));
}

/**
 * Streams new log lines to the settings window. Batched on a short timer so a burst
 * (a reconnect storm, a soak test) can't flood the renderer with IPC messages.
 */
export function streamLogsToWindow(getWindow: () => BrowserWindow | null): () => void {
  let pending: LogEntry[] = [];
  let timer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    timer = null;
    const batch = pending;
    pending = [];
    const win = getWindow();
    if (batch.length && win && !win.isDestroyed()) win.webContents.send('logs', batch);
  };

  return log.subscribe((entry) => {
    pending.push(entry);
    if (pending.length > 200) pending.splice(0, pending.length - 200);
    if (!timer) timer = setTimeout(flush, 150);
  });
}
