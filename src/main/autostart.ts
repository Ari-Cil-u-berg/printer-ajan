import { app } from 'electron';
import { log } from './logger';

/** Launch on login. Café tills stay logged in during business hours, so a login
 *  item is enough; the service split (§1) is only needed for logged-out printing. */
export function setAutostart(enabled: boolean): void {
  if (!app.isPackaged) return; // dev builds would register the electron binary
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true, // start straight to the tray, no window flash
      args: ['--hidden'],
    });
  } catch (err) {
    log.warn('autostart toggle failed', err);
  }
}

export function isAutostartEnabled(): boolean {
  if (!app.isPackaged) return false;
  try {
    return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
  } catch {
    return false;
  }
}
