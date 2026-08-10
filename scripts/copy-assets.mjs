// Copies non-TS files that tsc ignores into dist/ (renderer HTML/CSS, ps1, icons).
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copies = [
  ['src/renderer/index.html', 'dist/renderer/index.html'],
  ['src/renderer/styles.css', 'dist/renderer/styles.css'],
  ['src/main/print/raw-print.ps1', 'dist/main/assets/raw-print.ps1'],
  ['assets/tray.png', 'dist/main/assets/tray.png'],
  ['assets/trayTemplate.png', 'dist/main/assets/trayTemplate.png'],
  ['assets/trayTemplate@2x.png', 'dist/main/assets/trayTemplate@2x.png'],
];

// A plain `npm run build` is environment-neutral: drop any environment baked in by an
// earlier build:staging/build:prod so it can't leak into the next run.
await rm(path.join(root, 'dist/main/build-env.json'), { force: true });

for (const [from, to] of copies) {
  const dest = path.join(root, to);
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await cp(path.join(root, from), dest);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.warn(`[copy-assets] missing (skipped): ${from}`);
  }
}
console.log('[copy-assets] done');
