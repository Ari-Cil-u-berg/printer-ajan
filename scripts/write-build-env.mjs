/**
 * Bakes the target environment into the build so a packaged installer knows which
 * backend it belongs to without anyone setting a variable on the café PC.
 *
 *   node scripts/write-build-env.mjs production
 *
 * A real ARI_ENV in the process environment still wins at runtime (see src/main/env.ts).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VALID = ['development', 'staging', 'production'];
const env = (process.argv[2] ?? 'production').toLowerCase();
if (!VALID.includes(env)) {
  console.error(`[build-env] invalid environment "${env}" — expected one of ${VALID.join(', ')}`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'dist/main/build-env.json');
await mkdir(path.dirname(dest), { recursive: true });
await writeFile(dest, `${JSON.stringify({ env, builtAt: new Date().toISOString() }, null, 2)}\n`);
console.log(`[build-env] ${env}`);
