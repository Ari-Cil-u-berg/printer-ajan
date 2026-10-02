import { contextBridge, ipcRenderer } from 'electron';

/**
 * Müşteri ekranı penceresinin preload'u — POS'un `/musteri` sayfası için.
 *
 * Sayfa uzak bir kökenden yükleniyor; bu yüzden verilen yüzey en dar hâli:
 * yalnızca "kasadan yeni durum geldi" aboneliği. Node yok, ipcRenderer yok,
 * sayfa ajana hiçbir şey gönderemez.
 *
 * Son durum burada saklanır: ajan durumu `did-finish-load`'da gönderiyor, ama
 * sayfa o an henüz abone olmamış olabilir (arka plan ve logo da bu durumun
 * içinde gelir). Geç abone olan sayfa son durumu hemen alır.
 */
let last: unknown;
let hasLast = false;
const listeners: Array<(state: unknown) => void> = [];

ipcRenderer.on('customer-display:state', (_event, state: unknown) => {
  last = state;
  hasLast = true;
  for (const cb of listeners) cb(state);
});

contextBridge.exposeInMainWorld('ariCustomerDisplay', {
  onState: (cb: (state: unknown) => void): void => {
    listeners.push(cb);
    if (hasLast) cb(last);
  },
});
