import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { grantSecret, opMac, openEnvelope, sealEnvelope, verifyGrant, verifyOpMac } from '../dist/main/offline/crypto.js';
import { canonicalJson, validateOfflineOp } from '../dist/main/offline/protocol.js';
import { OFFLINE_TEST_VECTORS as V } from '../dist/main/offline/vectors.js';

/**
 * Sunucuyla AYNI baytlar: vektörler backend'in `offline-keys.spec.ts`'inde de
 * doğrulanıyor. Biri kırılırsa protokol ayrışmış demektir.
 */
const root = Buffer.from(V.rootSecret, 'utf8');
const key = createHmac('sha256', root).update(`hub:v1:${V.tenantId}:${V.branchId}:${V.keyVersion}`).digest();

test('vektör: merkez anahtarı, izin doğrulama, izin sırrı, kararlı JSON, işlem imzası', () => {
  assert.equal(key.toString('base64url'), V.hubKey);
  assert.deepEqual(verifyGrant(key, V.token), V.claims);
  assert.equal(grantSecret(key, V.claims.gid).toString('base64url'), V.secret);
  assert.equal(canonicalJson(V.op), V.canonicalOp);
  assert.equal(opMac(grantSecret(key, V.claims.gid), V.op), V.mac);
  assert.equal(validateOfflineOp(V.op), null);
});

test('vektör: zarf aynı baytlar ve geri açılıyor', () => {
  const secret = grantSecret(key, V.claims.gid);
  const sealed = sealEnvelope(secret, {
    grant: V.token,
    method: V.envelope.method,
    path: V.envelope.path,
    t: V.envelope.t,
    body: { ops: [V.op] },
    nonce: Buffer.from(V.envelope.nonceHex, 'hex'),
  });
  assert.equal(sealed.c, V.envelope.c);
  assert.deepEqual(openEnvelope(secret, sealed, 'POST', '/v1/ops'), { ops: [V.op] });
});

test('oynanmış izin, imza ve zarf reddedilir', () => {
  const secret = grantSecret(key, V.claims.gid);
  const otherKey = createHmac('sha256', root).update('hub:v1:tenant-1:branch-2:3').digest();
  assert.equal(verifyGrant(otherKey, V.token), null);
  assert.equal(verifyGrant(key, `${V.token}x`), null);
  assert.equal(verifyGrant(key, 42), null);
  assert.equal(verifyOpMac(secret, { ...V.op, guestCount: 9 }, V.mac), false);
  const sealed = sealEnvelope(secret, { grant: V.token, method: 'POST', path: '/v1/ops', t: 5, body: { a: 1 } });
  assert.equal(openEnvelope(secret, sealed, 'POST', '/v1/state'), null);
  assert.equal(openEnvelope(secret, { ...sealed, t: 6 }, 'POST', '/v1/ops'), null);
});
