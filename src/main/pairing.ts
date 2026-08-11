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

function endpoint(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl.replace(/\/$/, '')}${API_PREFIX}${path}`;
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
  const normalized = code.trim().toUpperCase().replace(/[\s-]/g, '');
  if (normalized.length < 6) throw new Error('Eşleştirme kodu en az 6 karakter olmalı');

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

  const body = (await res.json()) as Partial<PairResponse>;
  if (!body.deviceToken || !body.tenantId) throw new Error('Sunucudan geçersiz yanıt geldi');
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
