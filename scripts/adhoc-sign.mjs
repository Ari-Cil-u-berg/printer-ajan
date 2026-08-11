// Ad-hoc signs the packaged macOS app, as an electron-builder `afterPack` hook.
//
// `mac.identity: null` tells electron-builder to skip signing, and what it leaves
// behind is not an unsigned-but-coherent bundle: the Electron binary keeps its
// linker-signed ad-hoc signature while the bundle around it has no sealed
// resources and no bound Info.plist, so `codesign --verify` reports "code object
// is not signed at all". Apple Silicon refuses to execute code that fails that
// check, so the café's Mac would kill the app on launch rather than offer the
// "unidentified developer" dialog we are counting on.
//
// Signing with `-` (ad-hoc) seals the bundle without any certificate. It grants
// no trust — Gatekeeper still asks the user to allow it — but it makes the app a
// valid, launchable code object. Replace this hook with a real Developer ID
// identity in electron-builder.yml the day one exists.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // The universal target packs an x64 and an arm64 copy into `*-temp` directories
  // and lipos them together afterwards. Signing those inputs would only be undone
  // by the merge; the merged output is what ships, and it gets signed below.
  if (context.appOutDir.endsWith('-temp')) return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });

  console.log(`  • ad-hoc signed  file=${app}`);
}
