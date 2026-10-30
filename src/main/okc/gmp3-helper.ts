import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { log } from '../logger';

/**
 * Hugin GMP-3 yardımcı programıyla konuşma (native/hugin-fpu).
 *
 * Satır başına bir JSON, AYNI ANDA TEK İSTEK. Cihaz da tek belge tutuyor ve
 * kütüphanenin çağrıları birbirini bekliyor; sırayı burada tutmak, iki
 * çağrının aynı sokete karıştığı bir durumu imkânsız kılıyor.
 *
 * CEVAP TÜRLERİ para yolunun dayanağı:
 *  - `usage` / `not_connected`: cihaza HİÇBİR ŞEY gitmedi → güvenle ret.
 *  - `transport` / `timeout` / `exited`: gitti, cevap gelmedi → BİLMİYORUZ.
 *  - `match`: eşleme reddedildi → satış başlamadı.
 */

export type Gmp3ReplyKind = 'usage' | 'not_connected' | 'match' | 'transport' | 'timeout' | 'exited';

export interface Gmp3Reply {
  ok: boolean;
  /** Cihazın kendi cevabı (`"0|1|…"`). */
  raw?: string;
  kind?: Gmp3ReplyKind;
  error?: string;
  detail?: string;
  library?: string;
}

/** Testte sahte yardımcıyla değiştirilen tek yüzey. */
export interface Gmp3Transport {
  request(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<Gmp3Reply>;
  close(): void;
}

/** Bir isteğin sonucu cihaza gidip gitmediğini bilmiyor muyuz? */
export function isUncertain(reply: Gmp3Reply): boolean {
  return (
    !reply.ok && (reply.kind === 'transport' || reply.kind === 'timeout' || reply.kind === 'exited')
  );
}

/**
 * Paketlenmiş uygulamada `resources/hugin-fpu`, geliştirmede derleme çıktısı.
 * Electron'u içe aktarmıyor: testler bu dosyayı düz Node'da yüklüyor.
 */
export function helperPath(): string {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const packaged = resources ? path.join(resources, 'hugin-fpu', 'AriHuginFpu.exe') : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.resolve(__dirname, '..', '..', '..', 'native', 'hugin-fpu', 'out', 'AriHuginFpu.exe');
}

interface Pending {
  id: number;
  resolve: (reply: Gmp3Reply) => void;
  timer: NodeJS.Timeout;
}

const READY_TIMEOUT_MS = 15_000;

export class Gmp3Helper implements Gmp3Transport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<boolean> | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  /** İstekleri sıraya dizen zincir — bkz. dosya başı. */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * `args` yalnızca testte dolu (sahte yardımcıyı `node` ile başlatmak için).
   * Platform kontrolü burada değil, yöneticide: Windows dışında bu sınıfa hiç
   * gelinmiyor (`Gmp3OkcManager.unsupported`).
   */
  constructor(
    private readonly exePath: string = helperPath(),
    private readonly args: readonly string[] = [],
  ) {}

  request(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<Gmp3Reply> {
    const run = this.queue.then(() => this.send(cmd, args, timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.kill();
  }

  private async send(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<Gmp3Reply> {
    const started = await this.start();
    if (!started || !this.child) {
      return { ok: false, kind: 'usage', error: 'Yazarkasa yardımcı programı başlatılamadı' };
    }

    const id = this.nextId++;
    return new Promise<Gmp3Reply>((resolve) => {
      const timer = setTimeout(() => {
        // Cevapsız kalan çağrı, kütüphaneyi bilinmeyen bir hâlde bırakmış
        // olabilir. Süreci öldürüp yenisini açmak, aynı soketle devam edip
        // bir sonraki cevabı yanlış isteğe eşlemekten güvenli.
        log.warn('gmp3 yardımcı program cevap vermedi', { cmd, timeoutMs });
        this.settle(id, { ok: false, kind: 'timeout', error: 'Yazarkasa cevap vermedi' });
        this.kill();
      }, timeoutMs);
      this.pending = { id, resolve, timer };
      this.child?.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  private start(): Promise<boolean> {
    if (this.ready) return this.ready;
    if (!fs.existsSync(this.exePath)) return Promise.resolve(false);

    this.ready = new Promise<boolean>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        // Çalışma dizini programın klasörü: kütüphane `Certificates/`'i
        // göreli yoldan açıyor. Kabuk yok.
        child = spawn(this.exePath, [...this.args], {
          cwd: path.dirname(this.exePath),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        log.warn('gmp3 yardımcı program başlatılamadı', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.ready = null;
        resolve(false);
        return;
      }
      this.child = child;

      const readyTimer = setTimeout(() => {
        log.warn('gmp3 yardımcı program hazır olmadı');
        this.kill();
        resolve(false);
      }, READY_TIMEOUT_MS);

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        let message: { id?: unknown; ready?: unknown } & Gmp3Reply;
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          log.warn('gmp3 yardımcı programdan çözülemeyen satır');
          return;
        }
        if (message.ready === true) {
          clearTimeout(readyTimer);
          resolve(true);
          return;
        }
        if (typeof message.id === 'number') {
          const { id, ...reply } = message;
          delete (reply as { ready?: unknown }).ready;
          this.settle(id as number, reply);
        }
      });

      // Kütüphanenin kendi çıktısı: günlüğe, kısaltılmış.
      readline.createInterface({ input: child.stderr }).on('line', (line) => {
        if (line.trim()) log.warn('gmp3 yardımcı program', { line: line.slice(0, 300) });
      });

      child.on('error', (err) => {
        log.warn('gmp3 yardımcı program hatası', { error: err.message });
      });
      child.on('exit', (code) => {
        clearTimeout(readyTimer);
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        if (this.pending) {
          this.settle(this.pending.id, {
            ok: false,
            kind: 'exited',
            error: `Yazarkasa yardımcı programı kapandı (${code ?? 'sinyal'})`,
          });
        }
        resolve(false);
      });
    });
    return this.ready;
  }

  private settle(id: number, reply: Gmp3Reply): void {
    const pending = this.pending;
    if (!pending || pending.id !== id) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(reply);
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child && child.exitCode === null) child.kill();
  }
}
