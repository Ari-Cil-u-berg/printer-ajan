import { contextBridge, ipcRenderer } from 'electron';
import type { LogEntry, PrinterConfig, StatusSnapshot, Station, UpdateStatus } from '../shared/types';

/** The only surface the renderer gets — no Node, no ipcRenderer passthrough. */
const api = {
  getStatus: (): Promise<StatusSnapshot> => ipcRenderer.invoke('status:get'),
  onStatus: (cb: (status: StatusSnapshot) => void): void => {
    ipcRenderer.on('status', (_e, status: StatusSnapshot) => cb(status));
  },
  onUnauthorized: (cb: () => void): void => {
    ipcRenderer.on('unauthorized', () => cb());
  },
  pair: (code: string) => ipcRenderer.invoke('pair', code),
  unpair: () => ipcRenderer.invoke('unpair'),
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  scanNetwork: () => ipcRenderer.invoke('printers:scan'),
  setPrinter: (station: Station, printer: PrinterConfig | null) =>
    ipcRenderer.invoke('printers:set', station, printer),
  testPrint: (station: Station) => ipcRenderer.invoke('printers:test', station),
  probe: () => ipcRenderer.invoke('printers:probe'),
  setAutostart: (enabled: boolean) => ipcRenderer.invoke('settings:autostart', enabled),
  setDeviceName: (name: string) => ipcRenderer.invoke('settings:deviceName', name),
  checkUpdates: () => ipcRenderer.invoke('app:checkUpdates'),
  getUpdateStatus: () => ipcRenderer.invoke('app:updateStatus'),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  onUpdate: (cb: (status: UpdateStatus) => void): void => {
    ipcRenderer.on('update', (_e, status: UpdateStatus) => cb(status));
  },
  openLog: () => ipcRenderer.invoke('app:openLog'),
  openLogFolder: () => ipcRenderer.invoke('app:openLogFolder'),
  hide: () => ipcRenderer.invoke('app:hide'),
  getLogs: (): Promise<LogEntry[]> => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  onLogs: (cb: (entries: LogEntry[]) => void): void => {
    ipcRenderer.on('logs', (_e, entries: LogEntry[]) => cb(entries));
  },
};

contextBridge.exposeInMainWorld('agent', api);

export type AgentApi = typeof api;
