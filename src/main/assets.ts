import { app } from 'electron';
import path from 'node:path';

/**
 * Non-JS files (ps1 scripts, tray icons) are copied next to the compiled output by
 * scripts/copy-assets.mjs, and electron-builder ships dist/ inside the asar. The ps1
 * must be readable by powershell.exe, so it is unpacked (see electron-builder.yml).
 */
export function assetPath(...segments: string[]): string {
  return path.join(__dirname, 'assets', ...segments);
}

export function trayIconPath(): string {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  return assetPath(file);
}

export function appVersion(): string {
  return app.getVersion();
}
