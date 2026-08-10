/**
 * Cross-platform launcher: sets ARI_ENV and starts Electron against the built dist/.
 *
 *   node scripts/start.mjs --env=development
 *
 * .env files are read by the app itself (src/main/env.ts), not here.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const envArg = args.find((a) => a.startsWith('--env='));
const env = envArg ? envArg.slice('--env='.length) : 'development';
const passthrough = args.filter((a) => a !== envArg);

const electron = require('electron'); // resolves to the binary path string

const childEnv = {
  ...process.env,
  ARI_ENV: env,
  NODE_ENV: env === 'production' ? 'production' : 'development',
};
// Some shells (and agent runners) export this; it would boot Electron as plain Node
// and the app would crash on the first `app.` call.
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [root, ...passthrough], { stdio: 'inherit', env: childEnv });

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
