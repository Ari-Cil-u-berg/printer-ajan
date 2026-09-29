import { app } from 'electron';
import path from 'node:path';

/**
 * Non-JS files (ps1 scripts, tray icons) are copied next to the compiled output by
 * scripts/copy-assets.mjs, and electron-builder ships dist/ inside the asar.
 * Only raw-print.ps1 is unpacked (electron-builder.yml). Electron can read the
 * archive; powershell.exe cannot, so that script must use externalAssetPath.
 */
export function assetPath(...segments: string[]): string {
  return path.join(__dirname, 'assets', ...segments);
}

/**
 * Filesystem path for a program other than Electron. In a packaged build
 * __dirname sits inside app.asar, which PowerShell cannot open. The script is
 * copied beside it as app.asar.unpacked. The lookahead leaves an already
 * unpacked path alone. Dev paths contain neither name, so this is a no-op.
 */
export function externalAssetPath(...segments: string[]): string {
  return assetPath(...segments).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
}

export function trayIconPath(): string {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  return assetPath(file);
}

export function appVersion(): string {
  return app.getVersion();
}
