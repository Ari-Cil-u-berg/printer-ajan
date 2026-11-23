import { BrowserWindow, session as electronSession } from 'electron';
import type { LabelJob } from '../../../shared/types';
import { NotRetryablePrintError } from '../print-errors';
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
/** Sürücü kuyruğu yavaş olabilir (ilk baskıda sürücü yüklenir): çizimden uzun. */
const DRIVER_TIMEOUT_MS = 60_000;
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

/**
 * Pencereyle tek iş: süre dolunca beklemeyi bırakır AMA sırayı (`serial`) pencere kapanana
 * kadar tutar — zaman aşımında ikinci pencere eskisi açıkken açılmaz (CodeRabbit #14).
 * Pencere `dispose` ile yok edilince içerdeki yükleme/yazdırma da düşer.
 */
async function withWindow<T>(
  size: { width: number; height: number; offscreen: boolean },
  what: string,
  timeoutMs: number,
  work: (win: BrowserWindow) => Promise<T>,
): Promise<T> {
  const win = openWindow(size.width, size.height, size.offscreen);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LabelTimeoutError(`${what} zaman aşımı`)), timeoutMs);
  });
  try {
    return await Promise.race([work(win), timeout]);
  } finally {
    clearTimeout(timer);
    await dispose(win);
  }
}

/** Süre doldu. Sürücüye gönderildikten SONRA olduysa engine onu yeniden denemez (aşağıda). */
export class LabelTimeoutError extends Error {}

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

/** Etiketi yazıcının nokta ölçüsünde (genişlik 8'in katı) çizer. Kâğıda bir şey gitmez: zaman aşımı yeniden denenebilir. */
export function renderLabelBitmap(job: LabelJob): Promise<LabelBitmap> {
  const { width, height } = labelDots(job);
  return serial(() =>
    withWindow({ width, height, offscreen: true }, 'Etiket çizimi', RENDER_TIMEOUT_MS, async (win) => {
      // 1 CSS mm = dpi/25.4 nokta: 96 dpi CSS pikseli dpi/96 kadar büyütülür (HTML'de CSS zoom).
      await load(win, job, job.dpi / 96);
      const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
      // Ekran ölçeği ya da yuvarlama yüzünden boy farklıysa tam nokta ölçüsüne getir.
      const sized = image.getSize();
      const exact = sized.width === width && sized.height === height ? image : image.resize({ width, height, quality: 'best' });
      return { width, height, bgra: exact.toBitmap() };
    }),
  );
}

/**
 * Sürücü yolu: sayfa, kurulu yazıcıya etiket ölçüsünde, kenarsız ve sessiz gider.
 * Not (Electron sorun kaydı): bazı Windows sürücülerinde sessiz baskı `pageSize`ı yok sayıp
 * sürücünün varsayılan kâğıdını kullanır — kurulumda etiket ölçüsü sürücüde de seçilir.
 *
 * ÇİFT BASKI YOK (CodeRabbit #14): `print()` çağrıldıktan sonra süre dolarsa ya da sonuç
 * gelmezse etiket kâğıda çıkmış olabilir — hata `NotRetryablePrintError` olur, kuyruk aynı
 * etiketi ikinci kez basmaz. Sayfa yüklenirken düşerse (kâğıda bir şey gitmedi) yeniden denenir.
 */
export function printLabelViaDriver(job: LabelJob, deviceName: string): Promise<void> {
  // Sayfa CSS pikseliyle açılır (96 dpi); yazdırmada ölçüyü `@page` ve `pageSize` verir.
  const width = Math.max(64, Math.round((job.widthMm / 25.4) * 96));
  const height = Math.max(64, Math.round((job.heightMm / 25.4) * 96));
  let submitted = false;
  return serial(() =>
    withWindow({ width, height, offscreen: false }, 'Sürücüyle etiket', DRIVER_TIMEOUT_MS, async (win) => {
      await load(win, job);
      submitted = true;
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
    }).catch((err: unknown) => {
      if (submitted && err instanceof LabelTimeoutError) {
        throw new NotRetryablePrintError('Etiket sürücüye gönderildi ama sonucu alınamadı — çift basmasın diye yeniden denenmedi');
      }
      throw err;
    }),
  );
}
