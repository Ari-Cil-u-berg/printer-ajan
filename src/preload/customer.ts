import { contextBridge, ipcRenderer } from 'electron';

/**
 * Müşteri ekranı penceresinin preload'u — POS'un `/musteri` sayfası için.
 *
 * Sayfa uzak bir kökenden yükleniyor; bu yüzden verilen yüzey en dar hâli:
 * yalnızca "kasadan yeni durum geldi" aboneliği. Node yok, ipcRenderer yok,
 * sayfa ajana hiçbir şey gönderemez.
 */
contextBridge.exposeInMainWorld('ariCustomerDisplay', {
  onState: (cb: (state: unknown) => void): void => {
    ipcRenderer.on('customer-display:state', (_event, state: unknown) => cb(state));
  },
});
