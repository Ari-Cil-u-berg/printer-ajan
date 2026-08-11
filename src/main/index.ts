import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron';
import path from 'node:path';
import { STATIONS } from '../shared/types';
import type { ConnectionState, Station, StatusSnapshot } from '../shared/types';
import { Agent } from './agent';
import { trayIconPath } from './assets';
import { envConfig, takeEnvWarnings } from './env';
import { registerIpc, streamLogsToWindow } from './ipc';
import { log } from './logger';
import { checkForUpdatesNow, initAutoUpdate } from './updater';

const STATION_LABEL: Record<Station, string> = { BAR: 'Bar', KITCHEN: 'Mutfak', CASHIER: 'Kasa' };

let tray: Tray | null = null;
let window: BrowserWindow | null = null;
let agent: Agent | null = null;
let quitting = false;

const env = envConfig();

// Dev/staging runs keep their own userData tree: separate pairing token, queue and
// config, so testing against a mock gateway can never touch a café's live install.
if (env.env !== 'production') {
  app.setPath('userData', `${app.getPath('userData')}-${env.env}`);
}

// A second instance would fight over the queue file and the WS session.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  void app.whenReady().then(main);
}

async function main(): Promise<void> {
  if (process.platform === 'darwin') app.dock?.hide(); // tray-only app

  log.info('agent starting', {
    version: app.getVersion(),
    env: env.env,
    api: env.apiBaseUrl,
    ws: env.wsUrl,
    logLevel: env.logLevel,
    packaged: app.isPackaged,
    platform: `${process.platform} ${process.arch}`,
    userData: app.getPath('userData'),
    logFile: log.path(),
  });

  // env.ts cannot log for itself (the logger imports it), so it queues.
  for (const warning of takeEnvWarnings()) log.warn('env', warning);

  process.on('uncaughtException', (err) => log.error('uncaught exception', err));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason));

  agent = new Agent(app.getVersion());
  registerIpc(agent, () => window);
  streamLogsToWindow(() => window);
  agent.on('status', (status: StatusSnapshot) => {
    updateTray(status);
    window?.webContents.send('status', status);
  });
  agent.on('unauthorized', () => {
    showWindow();
    window?.webContents.send('unauthorized');
  });

  createTray();
  agent.start();
  initAutoUpdate();

  // First run (or after a revoke) has nothing to print — show the setup window.
  const launchedHidden = process.argv.includes('--hidden');
  if (!agent.config.isPaired() || !launchedHidden) showWindow();

  app.on('before-quit', () => {
    quitting = true;
    agent?.stop();
  });
  app.on('window-all-closed', () => {
    /* tray app — never quit on window close */
  });
}

function createTray(): void {
  const icon = nativeImage.createFromPath(trayIconPath());
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Ari Adisyon Yazıcı Ajanı');
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  updateTray(agent!.status());
}

const STATE_LABEL: Record<ConnectionState, string> = {
  CONNECTED: '🟢 Bağlı',
  CONNECTING: '🟡 Bağlanıyor…',
  OFFLINE: '🔴 Bağlantı yok',
  UNPAIRED: '⚪ Eşleştirilmemiş',
};

function updateTray(status: StatusSnapshot): void {
  if (!tray) return;
  const queued = status.queued > 0 ? `  •  Kuyrukta ${status.queued}` : '';
  tray.setToolTip(`Ari Adisyon  —  ${STATE_LABEL[status.connection]}${queued}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: STATE_LABEL[status.connection], enabled: false },
      status.paired && status.branchName
        ? { label: `${status.tenantName ?? ''} / ${status.branchName}`, enabled: false }
        : { label: 'Eşleştirme bekleniyor', enabled: false },
      { label: `Kuyrukta: ${status.queued}`, enabled: false },
      { type: 'separator' },
      { label: 'Ayarları aç', click: () => showWindow() },
      // Built from STATIONS: a station that exists but has no way to be tested
      // is a station nobody notices is broken until a customer is waiting.
      ...STATIONS.map((station) => ({
        label: `Test yazdır (${STATION_LABEL[station]})`,
        click: () => void agent?.testPrint(station).catch((e) => log.warn('test print failed', e)),
      })),
      { type: 'separator' },
      { label: 'Güncellemeleri denetle', click: () => checkForUpdatesNow() },
      { label: 'Günlük dosyasını aç', click: () => void shell.openPath(log.path()) },
      { label: 'Günlük klasörünü aç', click: () => shell.showItemInFolder(log.path()) },
      ...(env.env === 'production'
        ? []
        : [{ label: `Ortam: ${env.env}`, enabled: false } as const]),
      { type: 'separator' },
      { label: 'Çıkış', click: () => { quitting = true; app.quit(); } },
    ]),
  );
}

export function showWindow(): void {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 620,
    minHeight: 600,
    title:
      env.env === 'production'
        ? 'Ari Adisyon Yazıcı Ajanı'
        : `Ari Adisyon Yazıcı Ajanı — ${env.env.toUpperCase()}`,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  window.once('ready-to-show', () => {
    window?.show();
    if (env.devtools) window?.webContents.openDevTools({ mode: 'detach' });
  });

  // Closing the settings window only hides it — printing must keep running.
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on('closed', () => { window = null; });

  // Never let the renderer navigate or spawn windows. `openExternal` hands a
  // string to the OS, which will happily launch `file:`, `smb:` or any
  // registered custom scheme — so only ordinary web links get through.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    else log.warn('blocked external open', { scheme: url.slice(0, 12) });
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
}
