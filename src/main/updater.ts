import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { envConfig } from './env';
import { log } from './logger';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * macOS builds are unsigned until a Developer ID certificate exists (see the
 * `mac:` block in electron-builder.yml). Squirrel.Mac verifies the signature of
 * the build it downloaded before swapping it in, so on an unsigned app every
 * check ends in a failed install — it would download 180 MB over the café's
 * connection, six times a day, to throw it away. Skip until we can sign.
 */
function updatesSupported(): boolean {
  return process.platform !== 'darwin';
}

/**
 * Silent background updates. The installer is only applied on quit, so a café is
 * never interrupted mid-service by a restart.
 */
export function initAutoUpdate(): void {
  if (!app.isPackaged) return;
  if (!updatesSupported()) {
    log.info('auto-update unavailable on this platform (unsigned build)', {
      platform: process.platform,
    });
    return;
  }
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
  if (!app.isPackaged || !updatesSupported() || !envConfig().autoUpdate) return;
  void autoUpdater.checkForUpdates().catch((err) => log.warn('manual update check failed', err));
}
