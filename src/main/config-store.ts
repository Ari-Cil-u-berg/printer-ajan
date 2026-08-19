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
 * Two files in userData:
 *   config.json   — plaintext, non-secret (printer map, urls, pairing context)
 *   device.token  — safeStorage-encrypted device token (OS keychain-backed)
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
    autostart: true,
  };
}

export class ConfigStore {
  private readonly dir: string;
  private readonly configPath: string;
  private readonly tokenPath: string;
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
    this.tokenPath = path.join(dir, 'device.token');
    this.bridgeKeyPath = path.join(dir, 'bridge.key');
    fs.mkdirSync(dir, { recursive: true });
    this.config = this.load();
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

  // --- device token -------------------------------------------------------

  setToken(token: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      atomicWrite(this.tokenPath, safeStorage.encryptString(token));
    } else {
      // No OS keychain (e.g. fresh Linux session). Refuse to persist in the clear.
      log.warn('safeStorage unavailable — device token kept in memory only');
      this.volatileToken = token;
    }
  }

  private volatileToken: string | null = null;

  getToken(): string | null {
    if (this.volatileToken) return this.volatileToken;
    try {
      const buf = fs.readFileSync(this.tokenPath);
      return safeStorage.decryptString(buf);
    } catch {
      return null;
    }
  }

  clearToken(): void {
    this.volatileToken = null;
    try {
      fs.rmSync(this.tokenPath, { force: true });
    } catch {
      /* already gone */
    }
    this.update({ pairing: undefined });
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
    return this.getToken() !== null;
  }

  dataDir(): string {
    return this.dir;
  }
}
