import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { envConfig } from './env';
import { log } from './logger';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Silent background updates. The installer is only applied on quit, so a café is
 * never interrupted mid-service by a restart.
 */
export function initAutoUpdate(): void {
  if (!app.isPackaged) return;
  if (!envConfig().autoUpdate) {
    log.info('auto-update disabled for this environment', { env: envConfig().env });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => log.info('updater', m),
    warn: (m: unknown) => log.warn('updater', m),
    error: (m: unknown) => log.error('updater', m),
    debug: () => undefined,
  };

  autoUpdater.on('update-downloaded', (info) => log.info('update ready', { version: info.version }));
  autoUpdater.on('error', (err) => log.warn('update check failed', err));

  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  setTimeout(check, 30_000);
  setInterval(check, CHECK_INTERVAL_MS);
}

export function checkForUpdatesNow(): void {
  if (!app.isPackaged || !envConfig().autoUpdate) return;
  void autoUpdater.checkForUpdates().catch((err) => log.warn('manual update check failed', err));
}
