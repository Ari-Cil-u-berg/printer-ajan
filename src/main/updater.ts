import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../shared/types';
import { envConfig } from './env';
import { log } from './logger';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * First check runs soon after launch, not on the six-hour timer.
 *
 * Someone who has just opened the window is usually there BECAUSE something
 * needs attention, and "is this the current version?" is the first question a
 * support call asks. Five seconds is late enough to stay out of the way of
 * pairing and the first socket, early enough to have an answer by the time
 * anyone scrolls down to look for one.
 */
const FIRST_CHECK_MS = 5_000;

const DOWNLOAD_PAGE = 'https://github.com/Ari-Cil-u-berg/printer-ajan/releases/latest';

/**
 * macOS builds are unsigned until a Developer ID certificate exists (see the
 * `mac:` block in electron-builder.yml). Squirrel.Mac verifies the signature of
 * the build it downloaded before swapping it in, so on an unsigned app every
 * check ends in a failed install — it would download 180 MB over the café's
 * connection, six times a day, to throw it away.
 */
function unsupportedReason(): string | null {
  if (!app.isPackaged) return 'Geliştirme sürümünde güncelleme denetlenmez.';
  if (process.platform === 'darwin') {
    return "macOS sürümü Apple tarafından imzalanmadığı için kendini güncelleyemiyor. Yeni sürümü indirme sayfasından kurun.";
  }
  if (!envConfig().autoUpdate) {
    return `Bu ortamda (${envConfig().env}) güncelleme kapalı.`;
  }
  return null;
}

let status: UpdateStatus = {
  phase: 'idle',
  currentVersion: app.getVersion(),
};

let listener: ((status: UpdateStatus) => void) | null = null;

function set(patch: Partial<UpdateStatus>): void {
  // `newVersion` and `percent` are cleared unless the new phase carries them —
  // a stale "%73" left over from an abandoned download reads as a live one.
  status = {
    phase: status.phase,
    currentVersion: status.currentVersion,
    ...(status.checkedAt ? { checkedAt: status.checkedAt } : {}),
    ...(status.downloadUrl ? { downloadUrl: status.downloadUrl } : {}),
    ...patch,
  };
  listener?.(status);
}

export function updateStatus(): UpdateStatus {
  return status;
}

export function onUpdateStatus(cb: (status: UpdateStatus) => void): void {
  listener = cb;
}

export function initAutoUpdate(): void {
  const blocked = unsupportedReason();
  if (blocked) {
    log.info('auto-update unavailable', { platform: process.platform, reason: blocked });
    set({ phase: 'unsupported', detail: blocked, downloadUrl: DOWNLOAD_PAGE });
    return;
  }

  // Silent by default: the installer is applied on quit, so a café is never
  // interrupted mid-service by a restart it did not ask for. The window reports
  // what is happening; it does not drive it.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => log.info('updater', m),
    warn: (m: unknown) => log.warn('updater', m),
    error: (m: unknown) => log.error('updater', m),
    debug: () => undefined,
  };

  autoUpdater.on('checking-for-update', () => set({ phase: 'checking' }));

  autoUpdater.on('update-not-available', () => {
    set({ phase: 'current', checkedAt: new Date().toISOString() });
  });

  autoUpdater.on('update-available', (info) => {
    log.info('update available', { version: info.version });
    set({ phase: 'available', newVersion: info.version, checkedAt: new Date().toISOString() });
  });

  autoUpdater.on('download-progress', (progress) => {
    set({
      phase: 'downloading',
      ...(status.newVersion ? { newVersion: status.newVersion } : {}),
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('update ready', { version: info.version });
    set({ phase: 'downloaded', newVersion: info.version });
  });

  autoUpdater.on('error', (err) => {
    log.warn('update check failed', err);
    set({
      phase: 'error',
      detail: err instanceof Error ? err.message : String(err),
      checkedAt: new Date().toISOString(),
    });
  });

  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_INTERVAL_MS);
}

/**
 * A check the operator asked for, and can see the result of.
 *
 * Returns the status it starts from so the caller always has something to
 * render — the interesting states arrive afterwards, over the status channel.
 */
export function checkForUpdatesNow(): UpdateStatus {
  if (status.phase === 'unsupported') return status;
  if (status.phase === 'checking' || status.phase === 'downloading') return status;

  // A build that is already downloaded stays downloaded; re-checking would
  // only invite a second download of the same file.
  if (status.phase === 'downloaded') return status;

  set({ phase: 'checking' });
  void autoUpdater.checkForUpdates().catch((err) => {
    log.warn('manual update check failed', err);
    set({
      phase: 'error',
      detail: err instanceof Error ? err.message : String(err),
      checkedAt: new Date().toISOString(),
    });
  });
  return status;
}

/**
 * Restart into the new version, on request.
 *
 * The default path installs on quit precisely so nobody has to decide this
 * mid-service. This exists for the other case: a café that has just been told
 * an update is ready and would rather take the ten seconds now than find out
 * during the evening rush.
 */
export function installUpdateNow(): void {
  if (status.phase !== 'downloaded') throw new Error('Kurulacak bir güncelleme indirilmedi');
  log.info('installing update on request', { version: status.newVersion });
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}
