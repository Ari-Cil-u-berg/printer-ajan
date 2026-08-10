import assert from 'node:assert/strict';
import test from 'node:test';
import { log } from '../dist/main/logger.js';
import { envConfig } from '../dist/main/env.js';

// Tests run unpackaged with no ARI_ENV → the development preset (debug level).
test('unpackaged runs resolve to the development environment', () => {
  const cfg = envConfig();
  assert.equal(cfg.env, 'development');
  assert.equal(cfg.logLevel, 'debug');
  assert.equal(cfg.autoUpdate, false);
  assert.match(cfg.apiBaseUrl, /^https?:\/\//);
  assert.equal(cfg.apiBaseUrl.endsWith('/'), false);
});

test('entries land in the in-app buffer and reach subscribers', () => {
  log.clear();
  const seen = [];
  const unsubscribe = log.subscribe((e) => seen.push(e));

  log.info('hello viewer');
  log.warn('careful');
  unsubscribe();
  log.error('not seen by the unsubscribed listener');

  assert.deepEqual(seen.map((e) => e.level), ['info', 'warn']);
  assert.equal(seen[0].message, 'hello viewer');
  assert.match(seen[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(seen[1].id > seen[0].id);
  assert.deepEqual(log.entries().map((e) => e.level), ['info', 'warn', 'error']);
});

test('secrets never reach the buffer the user can copy out', () => {
  log.clear();
  log.info('pairing', { code: 'A7K2QP', token: 'devtok-123', branch: 'Merkez' });
  log.info('authorization=Bearer abcdef123');

  const dump = log.entries().map((e) => e.message).join('\n');
  assert.equal(dump.includes('A7K2QP'), false);
  assert.equal(dump.includes('devtok-123'), false);
  assert.equal(dump.includes('abcdef123'), false);
  assert.ok(dump.includes('Merkez'));
});

test('a throwing subscriber cannot break logging', () => {
  log.clear();
  const off = log.subscribe(() => {
    throw new Error('boom');
  });
  log.info('still logged');
  off();
  assert.equal(log.entries().length, 1);
});

test('clear empties the viewer buffer but keeps the file path', () => {
  log.info('before clear');
  const file = log.path();
  log.clear();
  assert.equal(log.entries().length, 0);
  assert.equal(log.path(), file);
  assert.match(file, /agent-development\.log$/);
});
