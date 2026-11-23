import { BrowserWindow, session as electronSession } from 'electron';
import type { LabelJob } from '../../../shared/types';
import { labelHtml } from './html';
import { labelDots } from './validate';

/**
 * Etiketi Chromium'da çizer (ajanın kendi gizli penceresi):
 *   `renderLabelBitmap` → BGRA piksel (ham yol: TSPL/ZPL/EPL/ESC-POS),
 *   `printLabelViaDriver` → işletim sisteminin sürücüsüne sessiz sayfa (DRIVER).
 *
 * Güvenlik: pencere görünmez, betik KAPALI (`javascript:false`), sandbox + bağlam ayrımı,
 * Node yok; bellekte ayrı oturum (`label-render`) ve o oturumda http/https/file/ws
 * istekleri iptal — sayfa yalnız kendi `data:` içeriğini ve logosunu görür. Gezinme ve yeni
 * pencere kapalı. HTML sunucudan gelmez, `labelHtml` metni kaçışlayarak kurar.
 *
 * Aynı anda tek çizim: iki etiket aynı anda iki pencere açmasın (küçük bilgisayarda bellek).
 */

const RENDER_TIMEOUT_MS = 15_000;
const PARTITION = 'label-render';

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

let sessionReady = false;
function lockedSession(): Electron.Session {
  const s = electronSession.fromPartition(PARTITION, { cache: false });
  if (!sessionReady) {
    s.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) =>
      cb({ cancel: true }),
    );
    s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    sessionReady = true;
  }
  return s;
}

function openWindow(width: number, height: number, offscreen: boolean): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      session: lockedSession(),
      offscreen,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webgl: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  return win;
}

/**
 * Pencereyi kapatır ve GERÇEKTEN kapanmasını bekler. Hemen ardından açılan ikinci pencere,
 * kapanmakta olan çizim sürecine düşüp `ERR_FAILED` alıyordu (23.11 duman testi: ilk etiket
 * basılıyor, ikincisi düşüyordu; bir koşuda Electron SIGSEGV ile kapandı).
 */
async function dispose(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  const contents = win.webContents;
  const gone = new Promise<void>((resolve) => {
    if (contents.isDestroyed()) return resolve();
    contents.once('destroyed', () => resolve());
  });
  const closed = new Promise<void>((resolve) => win.once('closed', () => resolve()));
  win.destroy();
  await Promise.race([Promise.all([gone, closed]), new Promise((r) => setTimeout(r, 2_000))]);
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} zaman aşımı`)), RENDER_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function load(win: BrowserWindow, job: LabelJob, scale = 1): Promise<void> {
  const painted = new Promise<void>((resolve) => win.once('ready-to-show', () => resolve()));
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(labelHtml(job, scale))}`);
  await painted;
}

export interface LabelBitmap {
  width: number;
  height: number;
  /** BGRA, `width * height * 4` bayt. */
  bgra: Buffer;
}

/** Etiketi yazıcının nokta ölçüsünde (genişlik 8'in katı) çizer. */
export function renderLabelBitmap(job: LabelJob): Promise<LabelBitmap> {
  return serial(() =>
    withTimeout(
      (async () => {
        const { width, height } = labelDots(job);
        const win = openWindow(width, height, true);
        try {
          // 1 CSS mm = dpi/25.4 nokta: 96 dpi CSS pikseli dpi/96 kadar büyütülür (HTML'de CSS zoom).
          await load(win, job, job.dpi / 96);
          const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
          // Ekran ölçeği ya da yuvarlama yüzünden boy farklıysa tam nokta ölçüsüne getir.
          const sized = image.getSize();
          const exact = sized.width === width && sized.height === height ? image : image.resize({ width, height, quality: 'best' });
          return { width, height, bgra: exact.toBitmap() };
        } finally {
          await dispose(win);
        }
      })(),
      'Etiket çizimi',
    ),
  );
}

/**
 * Sürücü yolu: sayfa, kurulu yazıcıya etiket ölçüsünde, kenarsız ve sessiz gider.
 * Not (Electron sorun kaydı): bazı Windows sürücülerinde sessiz baskı `pageSize`ı yok sayıp
 * sürücünün varsayılan kâğıdını kullanır — kurulumda etiket ölçüsü sürücüde de seçilir.
 */
export function printLabelViaDriver(job: LabelJob, deviceName: string): Promise<void> {
  return serial(() =>
    withTimeout(
      (async () => {
        // Sayfa CSS pikseliyle açılır (96 dpi); yazdırmada ölçüyü `@page` ve `pageSize` verir.
        const width = Math.max(64, Math.round((job.widthMm / 25.4) * 96));
        const height = Math.max(64, Math.round((job.heightMm / 25.4) * 96));
        const win = openWindow(width, height, false);
        try {
          await load(win, job);
          await new Promise<void>((resolve, reject) => {
            win.webContents.print(
              {
                silent: true,
                deviceName,
                printBackground: true,
                landscape: false,
                margins: { marginType: 'none' },
                // mikron
                pageSize: { width: Math.round(job.widthMm * 1000), height: Math.round(job.heightMm * 1000) },
              },
              (success, failureReason) => (success ? resolve() : reject(new Error(`Sürücüye gönderilemedi: ${failureReason || 'bilinmeyen hata'}`))),
            );
          });
        } finally {
          await dispose(win);
        }
      })(),
      'Sürücüyle etiket',
    ),
  );
}
