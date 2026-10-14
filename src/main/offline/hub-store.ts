import fs from 'node:fs';
import path from 'node:path';

import { atomicWrite } from '../fsutil';
import { log } from '../logger';
import type { HubData } from './hub-state';

/**
 * Merkezin diski — TEK dosya, işletim sistemi şifrelemesiyle.
 *
 * KVKK (docs/CEVRIMDISI-CALISMA.md §6): içinde menü, masalar, açık adisyonlar,
 * personel adı ve bekleyen işlemler var; müşteri adı/telefonu ve PIN yok.
 * Şifreleme Electron `safeStorage` (Windows DPAPI / macOS Keychain) — testte
 * sahte bir şifreleyici verilir. Şifreleme yoksa veri diske YAZILMAZ: kesinti
 * yeniden başlatmaya kadar bellekte tutulur ve günlüğe uyarı düşer.
 *
 * Yazım 200 ms birleştirilir ve atomiktir (yarım dosya kalmaz). Kesinti
 * ortasında ajan yeniden başlarsa bekleyen işlemler buradan geri gelir.
 */
export interface HubCipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

const FILE = 'offline-hub.bin';
const DEBOUNCE_MS = 200;

export class HubStore {
  private readonly file: string;
  private timer: NodeJS.Timeout | null = null;
  private latest: HubData | null = null;

  constructor(
    dataDir: string,
    private readonly cipher: HubCipher,
  ) {
    this.file = path.join(dataDir, FILE);
  }

  load(): HubData | null {
    if (!this.cipher.available()) return null;
    try {
      if (!fs.existsSync(this.file)) return null;
      const data = JSON.parse(this.cipher.decrypt(fs.readFileSync(this.file))) as HubData;
      return data?.v === 1 ? data : null;
    } catch (err) {
      // Başka bir kullanıcının anahtarıyla şifrelenmiş ya da bozuk: okunamaz,
      // sil — yanlış veriyle merkez olmaktansa buluttan yeniden almak doğru.
      log.warn('offline hub store unreadable — discarding', err);
      this.wipe();
      return null;
    }
  }

  save(data: HubData): void {
    this.latest = data;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Bekleyen yazımı hemen yap (kapanışta, aktarımdan önce). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const data = this.latest;
    if (!data) return;
    if (!this.cipher.available()) {
      log.warn('safeStorage yok — merkez verisi yalnızca bellekte');
      return;
    }
    try {
      atomicWrite(this.file, this.cipher.encrypt(JSON.stringify(data)));
    } catch (err) {
      log.warn('offline hub store write failed', err);
    }
  }

  /** Merkez rolü bittiğinde, eşleşme silinince, kaldırırken: hepsi gider. */
  wipe(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.latest = null;
    try {
      fs.rmSync(this.file, { force: true });
    } catch (err) {
      log.warn('offline hub store wipe failed', err);
    }
  }
}
