import { BrowserWindow, screen, type Display } from 'electron';
import path from 'node:path';
import { log } from './logger';

/**
 * MÜŞTERİ EKRANI PENCERESİ — ajan açar, seçilen monitörde, tam ekran.
 *
 * NEDEN AJAN: tarayıcı bir pencereyi başka monitöre ancak "pencere yönetimi"
 * izniyle, kullanıcı tıklamasıyla ve sürüme göre değişen kurallarla
 * yerleştiriyor; sahada pencere kasiyerin ekranında tam ekran açıldı. Electron
 * monitörleri kesin biliyor (`screen.getAllDisplays()`) ve pencereyi istenen
 * monitöre koyup tam ekran yapabiliyor — tarayıcı kuralı yok.
 *
 * Pencere POS'un kendi `/musteri` sayfasını yükler. Veri (kalemler, tutar)
 * kasadaki POS sekmesinden yerel köprüyle (local-bridge.ts) ajana, ajandan bu
 * pencereye `customer-display:state` olarak gelir; internet gerekmez.
 *
 * GÜVENLİK: pencere yalnızca POS kökenine gidebilir; yeni pencere açamaz;
 * preload yalnızca `onState` verir (Node yok, ipcRenderer yok).
 */

export interface DisplayView {
  id: number;
  /** Ekranda görünen ad: "Ekran 2". Numara, "Ekranları tanı"daki numarayla aynı. */
  name: string;
  /** Windows'un verdiği ad (varsa): "DELL P2419H". */
  label: string;
  size: string;
  primary: boolean;
  selected: boolean;
}

export class CustomerWindow {
  private win: BrowserWindow | null = null;
  private lastState: unknown = null;

  constructor(
    private readonly selectedDisplayId: () => number | undefined,
    private readonly posOrigin: () => Promise<string | null>,
  ) {
    // Monitör çıkarılıp takılınca pencereyi seçilen monitöre geri koy.
    screen.on('display-added', () => this.reposition());
    screen.on('display-removed', () => this.reposition());
    screen.on('display-metrics-changed', () => this.reposition());
  }

  /** Monitörler, soldan sağa — "Ekran 1, 2…" numarası bu sıradan. */
  displays(): DisplayView[] {
    const selected = this.selectedDisplayId();
    const primary = screen.getPrimaryDisplay().id;
    return ordered().map((display, index) => ({
      id: display.id,
      name: `Ekran ${index + 1}`,
      label: display.label ?? '',
      size: `${display.size.width}×${display.size.height}`,
      primary: display.id === primary,
      selected: display.id === selected,
    }));
  }

  isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  configured(): boolean {
    const id = this.selectedDisplayId();
    return id !== undefined && screen.getAllDisplays().some((display) => display.id === id);
  }

  /** Açar ya da zaten açıksa doğru monitöre taşıyıp öne getirir. */
  async open(): Promise<void> {
    const display = this.targetDisplay();
    if (!display) throw new Error('Müşteri ekranı seçilmedi.');
    const origin = await this.posOrigin();
    if (!origin) throw new Error('Sunucuya ulaşılamadı.');

    if (this.isOpen()) {
      this.place(this.win!, display);
      this.win!.show();
      return;
    }

    const { x, y, width, height } = display.bounds;
    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#000000',
      title: 'Müşteri ekranı',
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/customer.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win = win;
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });

    // Yalnızca POS kökeni. Başka her yer reddedilir; yeni pencere yok.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => {
      if (!sameOrigin(url, origin)) event.preventDefault();
    });
    win.webContents.on('did-finish-load', () => {
      if (this.lastState !== null) win.webContents.send('customer-display:state', this.lastState);
    });
    win.once('ready-to-show', () => {
      this.place(win, display);
      win.show();
    });

    await win.loadURL(`${origin}/musteri?kaynak=ajan`);
    log.info('customer display opened', { display: display.id });
  }

  close(): void {
    if (this.isOpen()) this.win!.close();
  }

  /** Kasadan gelen son durum; pencere yeniden yüklenince de tekrar gönderilir. */
  pushState(state: unknown): void {
    this.lastState = state;
    if (this.isOpen()) this.win!.webContents.send('customer-display:state', state);
  }

  /**
   * "Ekranları tanı": her monitörün ortasında 3 saniye büyük bir numara —
   * Windows'un "Tanımla" düğmesiyle aynı fikir. Yerel HTML, ağ yok.
   */
  identify(): void {
    ordered().forEach((display, index) => {
      const size = 260;
      const { x, y, width, height } = display.bounds;
      const badge = new BrowserWindow({
        x: Math.round(x + (width - size) / 2),
        y: Math.round(y + (height - size) / 2),
        width: size,
        height: size,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
      });
      const html =
        '<html><body style="margin:0;display:grid;place-items:center;height:100vh;background:transparent">' +
        `<div style="width:220px;height:220px;border-radius:32px;background:#b8232f;color:#fff;font:700 150px/220px system-ui;text-align:center">${index + 1}</div>` +
        '</body></html>';
      void badge.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      badge.once('ready-to-show', () => badge.showInactive());
      setTimeout(() => {
        if (!badge.isDestroyed()) badge.close();
      }, 3000);
    });
  }

  private targetDisplay(): Display | null {
    const all = ordered();
    const chosen = all.find((display) => display.id === this.selectedDisplayId());
    return chosen ?? null;
  }

  /** Monitöre koy ve tam ekran yap. Windows'ta önce çıkıp sonra girmek şart. */
  private place(win: BrowserWindow, display: Display): void {
    win.setFullScreen(false);
    win.setBounds(display.bounds);
    win.setFullScreen(true);
  }

  private reposition(): void {
    const display = this.targetDisplay();
    if (this.isOpen() && display) this.place(this.win!, display);
  }
}

function ordered(): Display[] {
  return [...screen.getAllDisplays()].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
