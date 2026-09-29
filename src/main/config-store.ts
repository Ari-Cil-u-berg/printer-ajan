import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfig } from '../shared/types';
import { envConfig } from './env';
import { atomicWrite } from './fsutil';
import { log } from './logger';

export { atomicWrite };

/**
 * Files in userData:
 *   config.json            — plaintext, non-secret (pairings, printer map, urls)
 *   tokens/<deviceId>.token — one safeStorage-encrypted token PER printer pairing
 *   device.token           — ≤0.3.21 single token; moved into tokens/ on load
 *
 * Writes are atomic (tmp + rename) so a crash mid-write can't corrupt config.
 */

function defaults(): AgentConfig {
  const env = envConfig();
  return {
    apiBaseUrl: env.apiBaseUrl,
    wsUrl: env.wsUrl,
    deviceName: os.hostname(),
    printers: {},
    pairings: [],
    autostart: true,
  };
}

export class ConfigStore {
  private readonly dir: string;
  private readonly configPath: string;
  /** ≤0.3.21 location of the single device token. */
  private readonly legacyTokenPath: string;
  private readonly tokenDir: string;
  /**
   * Köprü anahtarı AYRI DOSYADA.
   *
   * Yazıcı token'ıyla aynı dosyaya konsaydı, birini iptal etmek diğerini de
   * silerdi: yazıcı eşleştirmesini kaldıran bir kullanıcı, farkında olmadan
   * yazarkasayı da düşürürdü.
   */
  private readonly bridgeKeyPath: string;
  private config: AgentConfig;

  constructor(dir = app.getPath('userData')) {
    this.dir = dir;
    this.configPath = path.join(dir, 'config.json');
    this.legacyTokenPath = path.join(dir, 'device.token');
    this.tokenDir = path.join(dir, 'tokens');
    this.bridgeKeyPath = path.join(dir, 'bridge.key');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(this.tokenDir, { recursive: true });
    this.config = this.load();
    this.migrateSinglePairing();
  }

  /**
   * ≤0.3.21 → multi-pairing, once, on the first start after the update.
   *
   * The encrypted token bytes are MOVED, not re-encrypted: same keychain, same
   * bytes, no plaintext in between. The pairing keeps routing by station
   * (`legacyStationMap`) so the café's existing printer map keeps working
   * without anyone opening the window. Its pending acks move with it.
   */
  private migrateSinglePairing(): void {
    const legacy = this.config.pairing;
    if (!legacy || this.config.pairings.length > 0) return;
    if (!fs.existsSync(this.legacyTokenPath)) {
      this.update({ pairing: undefined });
      return;
    }
    try {
      fs.renameSync(this.legacyTokenPath, this.tokenFile(legacy.deviceId));
      const oldOutbox = path.join(this.dir, 'ack-outbox.json');
      if (fs.existsSync(oldOutbox)) {
        fs.renameSync(oldOutbox, path.join(this.dir, `ack-outbox-${legacy.deviceId}.json`));
      }
    } catch (err) {
      log.warn('pairing migration: token move failed', err);
      return;
    }
    this.update({
      pairing: undefined,
      pairings: [
        {
          deviceId: legacy.deviceId,
          printerName: legacy.printerName ?? legacy.branchName ?? 'Yazıcı',
          stations: [],
          tenantId: legacy.tenantId,
          branchId: legacy.branchId,
          tenantName: legacy.tenantName,
          branchName: legacy.branchName,
          pairedAt: new Date().toISOString(),
          legacyStationMap: true,
        },
      ],
    });
    log.info('migrated single pairing to multi-pairing', { deviceId: legacy.deviceId });
  }

  private tokenFile(deviceId: string): string {
    // deviceId comes from our own server, but it becomes a file name: keep it to
    // the characters an id is made of, so it can never walk out of tokens/.
    const safe = deviceId.replace(/[^A-Za-z0-9_-]/g, '');
    if (!safe) throw new Error('Geçersiz cihaz kimliği');
    return path.join(this.tokenDir, `${safe}.token`);
  }

  private load(): AgentConfig {
    const base = defaults();
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as Partial<AgentConfig>;
      // Endpoints always come from the environment, never from a stale config file —
      // otherwise a config written in dev would keep pointing a prod build at localhost.
      return {
        ...base,
        ...raw,
        apiBaseUrl: base.apiBaseUrl,
        wsUrl: base.wsUrl,
        printers: raw.printers ?? {},
        pairings: Array.isArray(raw.pairings) ? raw.pairings : [],
      };
    } catch {
      return base;
    }
  }

  get(): AgentConfig {
    return this.config;
  }

  update(patch: Partial<AgentConfig>): AgentConfig {
    this.config = { ...this.config, ...patch };
    atomicWrite(this.configPath, JSON.stringify(this.config, null, 2));
    return this.config;
  }

  // --- device tokens (one per printer pairing) --------------------------

  setToken(deviceId: string, token: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      atomicWrite(this.tokenFile(deviceId), safeStorage.encryptString(token));
      this.volatileTokens.delete(deviceId);
    } else {
      // No OS keychain (e.g. fresh Linux session). Refuse to persist in the clear.
      log.warn('safeStorage unavailable — device token kept in memory only');
      this.volatileTokens.set(deviceId, token);
    }
  }

  private readonly volatileTokens = new Map<string, string>();

  getToken(deviceId: string): string | null {
    const volatile = this.volatileTokens.get(deviceId);
    if (volatile) return volatile;
    try {
      return safeStorage.decryptString(fs.readFileSync(this.tokenFile(deviceId)));
    } catch {
      return null;
    }
  }

  /** Forgets one pairing: its token and its row. The others keep printing. */
  removePairing(deviceId: string): void {
    this.volatileTokens.delete(deviceId);
    try {
      fs.rmSync(this.tokenFile(deviceId), { force: true });
    } catch {
      /* already gone */
    }
    this.update({ pairings: this.config.pairings.filter((p) => p.deviceId !== deviceId) });
  }

  // --- köprü anahtarı -----------------------------------------------------

  setBridgeKey(key: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      atomicWrite(this.bridgeKeyPath, safeStorage.encryptString(key));
      this.volatileBridgeKey = null;
    } else {
      // OS anahtarlığı yoksa düz metin YAZMIYORUZ; bellekte tutuyoruz ve
      // yeniden başlatmada eşleştirme tekrar isteniyor.
      log.warn('safeStorage yok — köprü anahtarı yalnızca bellekte');
      this.volatileBridgeKey = key;
    }
  }

  private volatileBridgeKey: string | null = null;

  getBridgeKey(): string | null {
    if (this.volatileBridgeKey) return this.volatileBridgeKey;
    try {
      return safeStorage.decryptString(fs.readFileSync(this.bridgeKeyPath));
    } catch {
      return null;
    }
  }

  clearBridge(): void {
    this.volatileBridgeKey = null;
    try {
      fs.rmSync(this.bridgeKeyPath, { force: true });
    } catch {
      /* zaten yok */
    }
    this.update({ bridge: undefined });
  }

  isPaired(): boolean {
    return this.config.pairings.length > 0;
  }

  dataDir(): string {
    return this.dir;
  }
}
