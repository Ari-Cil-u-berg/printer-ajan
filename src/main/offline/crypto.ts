import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { canonicalJson, type OfflineGrantClaims, type OfflineOp } from './protocol';

/**
 * Merkezin kriptografisi — sunucudaki `apps/api/src/offline/offline-keys.ts`
 * ile birebir aynı baytlar (sabit vektörlerle test edilir). Ajan izni
 * İMZALAMAZ, yalnızca doğrular: izin buluttan gelir; ajanın elinde şubenin
 * merkez anahtarı var.
 */

export interface OfflineEnvelope {
  g: string;
  t: number;
  n: string;
  c: string;
}

export function grantSecret(key: Buffer, gid: string): Buffer {
  return createHmac('sha256', key).update(`grant-secret:${gid}`).digest();
}

/** İmza ve biçim doğruysa içerik; süre ve şube kontrolü ÇAĞIRANDA. */
export function verifyGrant(key: Buffer, token: unknown): OfflineGrantClaims | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OfflineGrantClaims;
    if (claims?.v !== 1 || typeof claims.uid !== 'string' || !Array.isArray(claims.perms) || typeof claims.exp !== 'number') {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export function opMac(secret: Buffer, op: OfflineOp): string {
  return createHmac('sha256', secret).update(canonicalJson(op)).digest('base64url');
}

export function verifyOpMac(secret: Buffer, op: OfflineOp, mac: unknown): boolean {
  if (typeof mac !== 'string' || mac.length > 64) return false;
  const expected = createHmac('sha256', secret).update(canonicalJson(op)).digest();
  const given = Buffer.from(mac, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Zarf AAD'si. İstek: `"{METHOD} {path} {t}"`. Cevap: `"RES {path} {t}"` —
 * istemcinin `t`'siyle; bir cevabın başka bir isteğe ya da başka bir uca
 * yapıştırılmasını engeller.
 */
export function envelopeAad(method: string, path: string, t: number): Buffer {
  return Buffer.from(`${method.toUpperCase()} ${path} ${t}`, 'utf8');
}

export function sealEnvelope(
  secret: Buffer,
  input: { grant: string; method: string; path: string; t: number; body: unknown; nonce?: Buffer },
): OfflineEnvelope {
  const nonce = input.nonce ?? randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, nonce);
  cipher.setAAD(envelopeAad(input.method, input.path, input.t));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(input.body), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { g: input.grant, t: input.t, n: nonce.toString('base64url'), c: encrypted.toString('base64url') };
}

export function openEnvelope(secret: Buffer, envelope: OfflineEnvelope, method: string, path: string): unknown {
  try {
    const nonce = Buffer.from(envelope.n, 'base64url');
    const data = Buffer.from(envelope.c, 'base64url');
    if (nonce.length !== 12 || data.length < 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', secret, nonce);
    decipher.setAAD(envelopeAad(method, path, envelope.t));
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

export function isEnvelope(value: unknown): value is OfflineEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.g === 'string' && typeof v.t === 'number' && typeof v.n === 'string' && typeof v.c === 'string';
}
