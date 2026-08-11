import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { isPrintJob } from '../dist/main/connection.js';
import { STATIONS } from '../dist/shared/types.js';

/**
 * Guards on data that crosses a trust boundary.
 *
 * Two boundaries exist: the gateway (jobs arrive over the socket) and the
 * process environment (whoever can set a variable on the till). Both are
 * "trusted" in the sense that we expect them to behave, and neither is trusted
 * in the sense that we act on whatever they say.
 */

const escpos = Buffer.from('hello').toString('base64');
const job = (over = {}) => ({ jobId: 'j1', station: 'BAR', copies: 1, escpos, ...over });

test('a well-formed job is accepted', () => {
  assert.equal(isPrintJob(job()), true);
  assert.equal(isPrintJob({ jobId: 'j2', station: 'KITCHEN', content: { orderNo: '17', items: [] } }), true);
});

test('a job without a printable body is rejected', () => {
  assert.equal(isPrintJob({ jobId: 'j', station: 'BAR' }), false);
  assert.equal(isPrintJob({ jobId: 'j', station: 'BAR', content: null }), false);
  assert.equal(isPrintJob(null), false);
  assert.equal(isPrintJob('job'), false);
});

test('an unknown station never reaches the queue', () => {
  assert.equal(isPrintJob(job({ station: 'TOILET' })), false);
  assert.equal(isPrintJob(job({ station: 42 })), false);
});

test('every station the backend can send is accepted — all of them', () => {
  // 0.1.2 accepted two of the three and dropped every cashier receipt as a
  // "malformed job payload". The guard is checked against the shared list, so
  // adding a station cannot leave this behind again.
  for (const station of STATIONS) {
    assert.equal(isPrintJob(job({ station })), true, station);
  }
  assert.deepEqual([...STATIONS], ['BAR', 'KITCHEN', 'CASHIER']);
});

test('the idempotency key is bounded — it is persisted for 24 hours', () => {
  assert.equal(isPrintJob(job({ jobId: '' })), false);
  assert.equal(isPrintJob(job({ jobId: 'x'.repeat(129) })), false);
  assert.equal(isPrintJob(job({ jobId: 'x'.repeat(128) })), true);
});

test('an oversized payload is refused before it is written to disk', () => {
  assert.equal(isPrintJob(job({ escpos: 'A'.repeat(1_000_001) })), false);
  assert.equal(isPrintJob(job({ escpos: 'A'.repeat(1_000_000) })), true);
});

test('a structured ticket cannot smuggle in unbounded content', () => {
  const items = (n, item = { qty: 1, name: 'Çay' }) => Array.from({ length: n }, () => item);
  const ticket = (over) => ({ jobId: 'j', station: 'BAR', content: { orderNo: '1', items: [], ...over } });

  assert.equal(isPrintJob(ticket({ items: items(200) })), true);
  assert.equal(isPrintJob(ticket({ items: items(201) })), false);
  assert.equal(isPrintJob(ticket({ items: [{ qty: 1, name: 'x'.repeat(501) }] })), false);
  assert.equal(isPrintJob(ticket({ items: [{ qty: 1, name: 'Çay', options: Array(51).fill('az şekerli') }] })), false);
  assert.equal(isPrintJob(ticket({ orderNo: 'x'.repeat(65) })), false);
  assert.equal(isPrintJob(ticket({ items: [{ name: 'no qty' }] })), false);
});

test('copies must be a number — the engine clamps the range, not the type', () => {
  assert.equal(isPrintJob(job({ copies: '9999' })), false);
  assert.equal(isPrintJob(job({ copies: Number.NaN })), false);
  assert.equal(isPrintJob(job({ copies: undefined })), true);
});

/**
 * The environment cases run in child processes: `envConfig()` memoises, and the
 * whole point is what a FRESH process does with a hostile variable.
 */
function envIn(vars) {
  const out = execFileSync(
    process.execPath,
    ['-e', 'const e=require("./dist/main/env.js");console.log(JSON.stringify({cfg:e.envConfig(),warnings:e.takeEnvWarnings()}))'],
    { env: { ...process.env, ...vars }, encoding: 'utf8' },
  );
  return JSON.parse(out);
}

test('production ignores an endpoint override — a variable must not redirect a till', () => {
  const { cfg, warnings } = envIn({ ARI_ENV: 'production', ARI_API_URL: 'https://evil.example' });
  assert.equal(cfg.apiBaseUrl, 'https://api.ariadisyon.com');
  assert.equal(cfg.wsUrl, 'wss://api.ariadisyon.com/agent');
  assert.ok(warnings.some((w) => w.includes('override ignored')));
});

test('production honours the override only when it is asked for explicitly', () => {
  const { cfg } = envIn({
    ARI_ENV: 'production',
    ARI_API_URL: 'https://canary.ariadisyon.com',
    ARI_ALLOW_ENDPOINT_OVERRIDE: '1',
  });
  assert.equal(cfg.apiBaseUrl, 'https://canary.ariadisyon.com');
});

test('a plaintext endpoint is refused outside development', () => {
  const { cfg, warnings } = envIn({
    ARI_ENV: 'staging',
    ARI_API_URL: 'http://evil.example',
    ARI_WS_URL: 'ws://evil.example/agent',
  });
  assert.equal(cfg.apiBaseUrl, 'https://staging-api.ariadisyon.com');
  assert.equal(cfg.wsUrl, 'wss://staging-api.ariadisyon.com/agent');
  assert.ok(warnings.some((w) => w.includes('insecure endpoint')));
});

test('development still points wherever the developer says', () => {
  const { cfg } = envIn({ ARI_ENV: 'development', ARI_API_URL: 'http://localhost:9999' });
  assert.equal(cfg.apiBaseUrl, 'http://localhost:9999');
});
