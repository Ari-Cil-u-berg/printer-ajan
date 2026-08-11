import os from 'node:os';
import type { DeviceInfo, PairResponse } from '../shared/types';
import { log } from './logger';

/**
 * The API is URI-versioned behind its global prefix, so the real path carries
 * `/api/v1`. Pinned here rather than folded into `apiBaseUrl`: when the backend
 * ships a v2, an agent already installed on a till must keep speaking v1 until
 * someone has checked the response shape — not silently follow whatever is
 * newest the moment it is deployed.
 *
 * The WebSocket is NOT versioned this way: an upgrade never reaches the router,
 * so the gateway owns the bare path `/agent`.
 */
const API_PREFIX = '/api/v1';

/**
 * The API wraps every successful body as `{ data: … }` — one unwrap path for
 * every client, so adding pagination meta to an endpoint is never a breaking
 * change. Errors use `{ error: … }` and we read those from the status instead.
 *
 * Reading `deviceToken` off the top level instead cost us every pairing in
 * 0.1.1: the server answered 200 and burned the single-use code, the agent
 * found no token in a body it had misread, and the operator's retry then failed
 * as "invalid code" — the code really was gone by then. Nothing caught it,
 * because the mock gateway and the integration test both replied with the bare
 * shape. They now speak the envelope, and tests/pairing.test.mjs pins it — a
 * bare body must FAIL there, or the fakes are free to drift again.
 */
function unwrap(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {};
  const data = (body as { data?: unknown }).data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

function endpoint(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl.replace(/\/$/, '')}${API_PREFIX}${path}`;
}

/**
 * The alphabet the backend generates from, mirrored here so a typo is caught in
 * the window rather than by a round trip that reports it as a bad code.
 *
 * It excludes every pair that gets misread off a screen across a room — `I/1`,
 * `L/1`, `O/0`, `U/V` — so a code containing one of those was misread, not
 * mistyped. Deliberately NOT "corrected" into a neighbour: silently turning an
 * `O` into a `0` would trade an obvious failure for a confusing one.
 */
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const PAIRING_CODE_LENGTH = 8;

/**
 * Accepts what a person actually types — lowercase, dashes, stray spaces — and
 * returns the canonical `XXXX-XXXX` the backend hashes. Null if it cannot be
 * one of our codes.
 */
export function normalizePairingCode(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  if (cleaned.length !== PAIRING_CODE_LENGTH) return null;
  if (![...cleaned].every((char) => PAIRING_ALPHABET.includes(char))) return null;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

export function deviceInfo(appVersion: string, deviceName?: string): DeviceInfo {
  return {
    hostname: deviceName || os.hostname(),
    platform: `${process.platform} ${os.release()}`,
    arch: process.arch,
    appVersion,
  };
}

/**
 * Exchanges a short-lived pairing code (≈15 min, single-use) for a durable,
 * revocable device token. The code is never persisted; only the token is stored,
 * and only via safeStorage.
 */
export async function pair(
  apiBaseUrl: string,
  code: string,
  info: DeviceInfo,
): Promise<PairResponse> {
  const normalized = normalizePairingCode(code);
  // Refused here, before the request: the backend answers wrong-shape and
  // wrong-code with the same message on purpose, so a round trip would report a
  // typo as "invalid or expired" and send the operator back to the panel for a
  // code that was never the problem.
  if (!normalized) {
    throw new Error('Kod 8 karakter olmalı (örnek: NSDP-25XR). Panelde yazanı birebir girin.');
  }

  const res = await fetch(endpoint(apiBaseUrl, '/agent/pair'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: normalized, deviceInfo: info }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    log.warn('pairing rejected', { status: res.status });
    throw new Error(pairingError(res.status, detail));
  }

  const body = unwrap(await res.json().catch(() => null)) as Partial<PairResponse>;
  if (!body.deviceToken || !body.tenantId) {
    // The server accepted the code to answer at all, which means it is spent.
    // Say so: telling someone to retype a code that cannot work again is how
    // this failure hid behind a second, misleading error.
    log.error('pairing succeeded but the response could not be read');
    throw new Error('Sunucu yanıtı okunamadı. Kod kullanıldı — panelden yeni bir kod alın.');
  }
  return body as PairResponse;
}

function pairingError(status: number, detail: string): string {
  // 401 is what the backend answers for wrong, expired and already-used alike —
  // deliberately one message, so a stranger cannot learn which of the three it
  // was and keep guessing.
  if (status === 401 || status === 404 || status === 400) {
    return 'Kod geçersiz veya süresi dolmuş. Panelden yeni bir kod alın.';
  }
  if (status === 410) return 'Kodun süresi doldu (15 dk). Panelden yeni bir kod alın.';
  if (status === 409) return 'Bu kod zaten kullanılmış. Panelden yeni bir kod alın.';
  if (status === 429) return 'Çok fazla deneme. Birkaç dakika sonra tekrar deneyin.';
  return `Eşleştirme başarısız (${status}). ${detail.slice(0, 120)}`.trim();
}

/** Best-effort liveness ping; failures are non-fatal (the WS is the real signal). */
export async function heartbeat(apiBaseUrl: string, token: string, appVersion: string): Promise<void> {
  try {
    await fetch(endpoint(apiBaseUrl, '/agent/heartbeat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ appVersion }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.warn('heartbeat failed', err);
  }
}
