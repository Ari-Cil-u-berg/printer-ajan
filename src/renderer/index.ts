/**
 * Settings window. Plain script (no bundler): talks to the main process only
 * through the `agent` bridge exposed by the preload.
 */

type Station = 'BAR' | 'KITCHEN' | 'CASHIER';
type Result<T> = { ok: true; data: T } | { ok: false; error: string };
type AppEnv = 'development' | 'staging' | 'production';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry { id: number; at: string; level: LogLevel; message: string }

interface PrinterTargetNet { kind: 'network'; host: string; port: number }
interface PrinterTargetSpool { kind: 'spooler'; printerName: string }
interface PrinterConfig {
  target: PrinterTargetNet | PrinterTargetSpool;
  codepage: string;
  width: 32 | 42 | 48;
  cut: boolean;
}
interface StatusSnapshot {
  connection: 'OFFLINE' | 'CONNECTING' | 'CONNECTED' | 'UNPAIRED';
  paired: boolean;
  tenantName?: string;
  branchName?: string;
  deviceName: string;
  appVersion: string;
  env: AppEnv;
  apiBaseUrl: string;
  logLevel: LogLevel;
  autostart: boolean;
  queued: number;
  lastJob?: { jobId: string; station: Station; status: string; at: string; error?: string };
  printers: Partial<Record<Station, PrinterConfig>>;
  printerHealth: Partial<Record<Station, { ok: boolean; checkedAt: string; error?: string }>>;
}
interface DiscoveredPrinter {
  kind: 'spooler' | 'network';
  label: string;
  printerName?: string;
  host?: string;
  port?: number;
}
type UpdatePhase =
  | 'unsupported' | 'idle' | 'checking' | 'current'
  | 'available' | 'downloading' | 'downloaded' | 'error';

interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  newVersion?: string;
  percent?: number;
  detail?: string;
  checkedAt?: string;
  downloadUrl?: string;
}

interface AgentBridge {
  getStatus(): Promise<StatusSnapshot>;
  onStatus(cb: (s: StatusSnapshot) => void): void;
  onUnauthorized(cb: () => void): void;
  pair(code: string): Promise<Result<StatusSnapshot>>;
  unpair(): Promise<Result<StatusSnapshot>>;
  listPrinters(): Promise<Result<DiscoveredPrinter[]>>;
  scanNetwork(): Promise<Result<DiscoveredPrinter[]>>;
  setPrinter(station: Station, printer: PrinterConfig | null): Promise<Result<StatusSnapshot>>;
  testPrint(station: Station): Promise<Result<boolean>>;
  probe(): Promise<Result<StatusSnapshot>>;
  setAutostart(enabled: boolean): Promise<Result<StatusSnapshot>>;
  setDeviceName(name: string): Promise<Result<StatusSnapshot>>;
  checkUpdates(): Promise<Result<UpdateStatus>>;
  getUpdateStatus(): Promise<Result<UpdateStatus>>;
  installUpdate(): Promise<Result<boolean>>;
  onUpdate(cb: (status: UpdateStatus) => void): void;
  openLog(): Promise<Result<string>>;
  openLogFolder(): Promise<Result<boolean>>;
  hide(): Promise<void>;
  getLogs(): Promise<LogEntry[]>;
  clearLogs(): Promise<Result<boolean>>;
  onLogs(cb: (entries: LogEntry[]) => void): void;
}

const bridge = (window as unknown as { agent: AgentBridge }).agent;

const STATION_LABEL: Record<Station, string> = { BAR: 'Bar', KITCHEN: 'Mutfak', CASHIER: 'Kasa' };
const STATIONS: Station[] = ['BAR', 'KITCHEN', 'CASHIER'];
const CODEPAGE_OPTIONS = ['CP857', 'ISO8859_9', 'CP1254', 'CP850', 'CP437'];
const STATE_TEXT = {
  CONNECTED: ['Bağlı', 'ok'],
  CONNECTING: ['Bağlanıyor…', 'warn'],
  OFFLINE: ['Bağlantı yok', 'bad'],
  UNPAIRED: ['Eşleştirilmemiş', ''],
} as const;

const ENV_LABEL: Record<AppEnv, string> = {
  development: 'Geliştirme',
  staging: 'Test (staging)',
  production: 'Canlı',
};
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** Keep the DOM bounded — the main process buffer is the real scrollback. */
const LOG_VIEW_MAX = 1000;

let discovered: DiscoveredPrinter[] = [];
let currentStatus: StatusSnapshot | null = null;
let logEntries: LogEntry[] = [];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function setMsg(el: HTMLElement, text: string, kind: 'ok' | 'bad' | '' = ''): void {
  el.textContent = text;
  el.className = `msg${kind ? ` ${kind}` : ''}`;
}

// --- rendering -------------------------------------------------------------

function render(s: StatusSnapshot): void {
  currentStatus = s;
  const [text, cls] = STATE_TEXT[s.connection];
  $('stateText').textContent = text;
  $('dot').className = `dot ${cls}`;
  $('sConn').textContent = text;
  $('sQueue').textContent = String(s.queued);
  $('sVersion').textContent = s.appVersion;
  $('sEnv').textContent = `${ENV_LABEL[s.env]} · ${s.apiBaseUrl}`;

  const badge = $('envBadge');
  badge.classList.toggle('hidden', s.env === 'production');
  badge.textContent = s.env.toUpperCase();
  badge.className = `env ${s.env}${s.env === 'production' ? ' hidden' : ''}`;
  $('place').textContent = s.paired && s.branchName ? `${s.tenantName ?? ''} — ${s.branchName}` : 'Henüz eşleştirilmedi';

  $('sLast').textContent = s.lastJob
    ? `${STATION_LABEL[s.lastJob.station]} · ${s.lastJob.status}${s.lastJob.error ? ` (${s.lastJob.error})` : ''}`
    : '—';

  const nameInput = $<HTMLInputElement>('deviceName');
  if (document.activeElement !== nameInput) nameInput.value = s.deviceName;

  $<HTMLInputElement>('autostart').checked = s.autostart;

  $('pairedBox').classList.toggle('hidden', !s.paired);
  $('pairCard').querySelector('.row')?.classList.toggle('hidden', s.paired);
  $('pairedPlace').textContent = `${s.tenantName ?? ''} / ${s.branchName ?? ''}`;

  renderStations(s);
}

function renderStations(s: StatusSnapshot): void {
  const host = $('stations');
  host.innerHTML = '';
  for (const station of STATIONS) {
    host.appendChild(stationCard(station, s.printers[station], s.printerHealth[station]));
  }
}

function stationCard(
  station: Station,
  printer: PrinterConfig | undefined,
  health: { ok: boolean; error?: string } | undefined,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'station';

  const badge = printer
    ? health
      ? health.ok ? '🟢 hazır' : `🔴 ${health.error ?? 'ulaşılamıyor'}`
      : '⏳ denetleniyor'
    : '⚪ seçilmedi';
  const title = document.createElement('h3');
  title.textContent = `${STATION_LABEL[station]} yazıcısı — ${badge}`;
  card.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'grid';

  // Connection type
  const typeSelect = document.createElement('select');
  for (const [value, label] of [['network', 'Ağ yazıcısı (IP)'], ['spooler', 'Bilgisayara kurulu yazıcı (USB)']]) {
    typeSelect.append(new Option(label!, value!));
  }
  typeSelect.value = printer?.target.kind ?? 'network';
  grid.append(label('Bağlantı'), typeSelect);

  // Network fields
  const hostInput = document.createElement('input');
  hostInput.type = 'text';
  hostInput.placeholder = '192.168.1.50';
  hostInput.value = printer?.target.kind === 'network' ? printer.target.host : '';
  const portInput = document.createElement('input');
  portInput.type = 'number';
  portInput.value = String(printer?.target.kind === 'network' ? printer.target.port : 9100);
  const netRow = document.createElement('div');
  netRow.className = 'row';
  netRow.style.marginTop = '0';
  hostInput.style.flex = '1';
  portInput.style.width = '90px';
  netRow.append(hostInput, portInput);
  const netLabel = label('IP ve port');
  grid.append(netLabel, netRow);

  // Spooler field
  const spoolSelect = document.createElement('select');
  const refreshSpoolOptions = () => {
    spoolSelect.innerHTML = '';
    const names = discovered.filter((d) => d.kind === 'spooler').map((d) => d.printerName!);
    const current = printer?.target.kind === 'spooler' ? printer.target.printerName : '';
    if (current && !names.includes(current)) names.unshift(current);
    if (names.length === 0) spoolSelect.append(new Option('(kurulu yazıcı bulunamadı)', ''));
    for (const n of names) spoolSelect.append(new Option(n, n));
    if (current) spoolSelect.value = current;
  };
  refreshSpoolOptions();
  const spoolLabel = label('Yazıcı');
  grid.append(spoolLabel, spoolSelect);

  // Codepage + width + cut
  const cpSelect = document.createElement('select');
  for (const cp of CODEPAGE_OPTIONS) cpSelect.append(new Option(cp.replace('_', '-'), cp));
  cpSelect.value = printer?.codepage ?? 'CP857';
  grid.append(label('Türkçe kod sayfası'), cpSelect);

  const widthSelect = document.createElement('select');
  for (const [v, l] of [['42', '80 mm (42 karakter)'], ['32', '58 mm (32 karakter)'], ['48', '80 mm (48 karakter)']]) {
    widthSelect.append(new Option(l!, v!));
  }
  widthSelect.value = String(printer?.width ?? 42);
  grid.append(label('Kağıt genişliği'), widthSelect);

  const cutBox = document.createElement('input');
  cutBox.type = 'checkbox';
  cutBox.checked = printer?.cut !== false;
  const cutWrap = document.createElement('label');
  cutWrap.className = 'check';
  cutWrap.append(cutBox, document.createTextNode(' Fiş sonunda kağıdı kes'));
  grid.append(label('Kesici'), cutWrap);

  card.appendChild(grid);

  const applyTypeVisibility = () => {
    const isNet = typeSelect.value === 'network';
    netLabel.classList.toggle('hidden', !isNet);
    netRow.classList.toggle('hidden', !isNet);
    spoolLabel.classList.toggle('hidden', isNet);
    spoolSelect.classList.toggle('hidden', isNet);
  };
  typeSelect.addEventListener('change', applyTypeVisibility);
  applyTypeVisibility();

  const msg = document.createElement('p');
  msg.className = 'msg';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary';
  saveBtn.textContent = 'Kaydet';
  saveBtn.addEventListener('click', async () => {
    const target =
      typeSelect.value === 'network'
        ? { kind: 'network' as const, host: hostInput.value.trim(), port: Number(portInput.value) || 9100 }
        : { kind: 'spooler' as const, printerName: spoolSelect.value };
    const cfg: PrinterConfig = {
      target,
      codepage: cpSelect.value,
      width: Number(widthSelect.value) as 32 | 42 | 48,
      cut: cutBox.checked,
    };
    const res = await bridge.setPrinter(station, cfg);
    if (res.ok) setMsg(msg, 'Kaydedildi.', 'ok');
    else setMsg(msg, res.error, 'bad');
  });

  const testBtn = document.createElement('button');
  testBtn.textContent = 'Test yazdır';
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    setMsg(msg, 'Gönderiliyor…');
    const res = await bridge.testPrint(station);
    testBtn.disabled = false;
    setMsg(
      msg,
      res.ok ? 'Test fişi gönderildi. Türkçe harfleri kontrol edin.' : res.error,
      res.ok ? 'ok' : 'bad',
    );
  });

  const clearBtn = document.createElement('button');
  clearBtn.className = 'ghost';
  clearBtn.textContent = 'Kaldır';
  clearBtn.addEventListener('click', async () => {
    const res = await bridge.setPrinter(station, null);
    if (!res.ok) setMsg(msg, res.error, 'bad');
  });

  const row = document.createElement('div');
  row.className = 'row';
  row.append(saveBtn, testBtn, clearBtn);
  card.append(row, msg);
  return card;
}

function label(text: string): HTMLElement {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}

// --- logs -------------------------------------------------------------------

function logFilters(): { min: number; needle: string } {
  return {
    min: LEVEL_ORDER[$<HTMLSelectElement>('logLevelFilter').value as LogLevel] ?? LEVEL_ORDER.info,
    needle: $<HTMLInputElement>('logSearch').value.trim().toLowerCase(),
  };
}

function visibleLogs(): LogEntry[] {
  const { min, needle } = logFilters();
  return logEntries.filter(
    (e) => LEVEL_ORDER[e.level] >= min && (!needle || e.message.toLowerCase().includes(needle)),
  );
}

function logRow(entry: LogEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = `logrow ${entry.level}`;
  const time = document.createElement('span');
  time.className = 'logtime';
  time.textContent = entry.at.slice(11, 19);
  const level = document.createElement('span');
  level.className = 'loglevel';
  level.textContent = entry.level.toUpperCase();
  const msg = document.createElement('span');
  msg.className = 'logmsg';
  msg.textContent = entry.message;
  row.append(time, level, msg);
  return row;
}

function atBottom(view: HTMLElement): boolean {
  return view.scrollTop + view.clientHeight >= view.scrollHeight - 24;
}

function renderLogs(): void {
  const view = $('logView');
  const frag = document.createDocumentFragment();
  for (const entry of visibleLogs()) frag.appendChild(logRow(entry));
  view.innerHTML = '';
  view.appendChild(frag);
  if ($<HTMLInputElement>('logFollow').checked) view.scrollTop = view.scrollHeight;
}

function appendLogs(entries: LogEntry[]): void {
  const view = $('logView');
  const follow = $<HTMLInputElement>('logFollow').checked;
  const stick = follow && atBottom(view);
  const { min, needle } = logFilters();

  logEntries.push(...entries);
  if (logEntries.length > LOG_VIEW_MAX) logEntries.splice(0, logEntries.length - LOG_VIEW_MAX);

  for (const entry of entries) {
    if (LEVEL_ORDER[entry.level] < min) continue;
    if (needle && !entry.message.toLowerCase().includes(needle)) continue;
    view.appendChild(logRow(entry));
  }
  while (view.childElementCount > LOG_VIEW_MAX) view.firstElementChild?.remove();
  if (stick) view.scrollTop = view.scrollHeight;
}

async function copyLogs(): Promise<void> {
  const text = visibleLogs().map((e) => `${e.at} [${e.level}] ${e.message}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    setMsg($('logMsg'), 'Kopyalandı.', 'ok');
  } catch {
    // file:// pages don't always get the async clipboard — fall back to a selection copy.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    setMsg($('logMsg'), ok ? 'Kopyalandı.' : 'Kopyalanamadı.', ok ? 'ok' : 'bad');
  }
}

// --- wiring ----------------------------------------------------------------

async function refreshPrinters(): Promise<void> {
  const res = await bridge.listPrinters();
  if (res.ok) {
    discovered = res.data;
    if (currentStatus) renderStations(currentStatus);
  }
}

$('pairBtn').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('code');
  const btn = $<HTMLButtonElement>('pairBtn');
  const msg = $('pairMsg');
  btn.disabled = true;
  setMsg(msg, 'Bağlanıyor…');
  const res = await bridge.pair(input.value);
  btn.disabled = false;
  if (res.ok) {
    input.value = '';
    setMsg(msg, 'Bağlandı.', 'ok');
    render(res.data);
  } else {
    setMsg(msg, res.error, 'bad');
  }
});

$('code').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') $('pairBtn').click();
});

$('unpairBtn').addEventListener('click', async () => {
  const res = await bridge.unpair();
  if (res.ok) render(res.data);
});

$('refreshBtn').addEventListener('click', () => void refreshPrinters());

$('scanBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('scanBtn');
  btn.disabled = true;
  setMsg($('scanMsg'), 'Ağ taranıyor… (birkaç saniye)');
  const res = await bridge.scanNetwork();
  btn.disabled = false;
  if (!res.ok) return setMsg($('scanMsg'), res.error, 'bad');
  setMsg(
    $('scanMsg'),
    res.data.length ? `Bulundu: ${res.data.map((d) => d.label).join(', ')}` : 'Ağda yazıcı bulunamadı.',
    res.data.length ? 'ok' : '',
  );
});

$('autostart').addEventListener('change', (e) => {
  void bridge.setAutostart((e.target as HTMLInputElement).checked);
});

$('deviceName').addEventListener('change', (e) => {
  void bridge.setDeviceName((e.target as HTMLInputElement).value);
});

$('updateBtn').addEventListener('click', async () => {
  const res = await bridge.checkUpdates();
  if (res.ok) renderUpdate(res.data);
});

$('updateInstallBtn').addEventListener('click', async () => {
  const res = await bridge.installUpdate();
  if (!res.ok) {
    $('updateDetail').textContent = res.error;
  }
});

$('updateDownloadBtn').addEventListener('click', () => {
  if (updateState?.downloadUrl) window.open(updateState.downloadUrl, '_blank');
});
$('logBtn').addEventListener('click', () => void bridge.openLog());
$('hideBtn').addEventListener('click', () => void bridge.hide());

$('logLevelFilter').addEventListener('change', renderLogs);
$('logSearch').addEventListener('input', renderLogs);
$('logCopyBtn').addEventListener('click', () => void copyLogs());
$('logFileBtn').addEventListener('click', () => void bridge.openLog());
$('logFolderBtn').addEventListener('click', () => void bridge.openLogFolder());
$('logClearBtn').addEventListener('click', async () => {
  await bridge.clearLogs();
  logEntries = [];
  renderLogs();
  setMsg($('logMsg'), 'Ekran temizlendi (dosya korunur).');
});

let updateState: UpdateStatus | null = null;

/**
 * One line that is always true, and buttons that only appear when they do
 * something.
 *
 * The old screen had a "Güncellemeleri denetle" button that reported nothing at
 * all — a click looked identical whether the app was current, an update was
 * downloading, or the check had failed. Every phase below says which of those
 * it is, and `unsupported` says so plainly rather than spinning forever on a
 * macOS build that cannot update itself.
 */
function renderUpdate(u: UpdateStatus): void {
  updateState = u;
  const dot = $('updateDot');
  const text = $('updateText');
  const detail = $('updateDetail');
  const install = $('updateInstallBtn');
  const download = $('updateDownloadBtn');
  const check = $<HTMLButtonElement>('updateBtn');

  const checked = u.checkedAt
    ? `Son denetim: ${new Date(u.checkedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`
    : '';

  let tone = '';
  let line = '';
  let note = checked;
  let busy = false;

  switch (u.phase) {
    case 'unsupported':
      line = `Sürüm ${u.currentVersion}`;
      note = u.detail ?? '';
      break;
    case 'checking':
      line = 'Güncellemeler denetleniyor…';
      busy = true;
      break;
    case 'current':
      tone = 'ok';
      line = `Güncel — sürüm ${u.currentVersion}`;
      break;
    case 'available':
      tone = 'warn';
      line = `Yeni sürüm var: ${u.newVersion ?? ''}`;
      note = 'İndirme arka planda başladı.';
      break;
    case 'downloading':
      tone = 'warn';
      busy = true;
      line = `İndiriliyor… %${u.percent ?? 0}`;
      note = 'Kafeyi bölmez, arka planda iner.';
      break;
    case 'downloaded':
      tone = 'ok';
      line = `${u.newVersion ?? 'Güncelleme'} indirildi`;
      note = 'Uygulamadan çıkınca kendiliğinden kurulur. Şimdi kurmak isterseniz yeniden başlatın.';
      break;
    case 'error':
      tone = 'bad';
      line = 'Güncelleme denetlenemedi';
      note = [u.detail, checked].filter(Boolean).join(' · ');
      break;
    default:
      line = `Sürüm ${u.currentVersion}`;
  }

  dot.className = `update-dot ${busy ? 'busy' : tone}`.trim();
  text.textContent = line;
  detail.textContent = note;
  detail.classList.toggle('hidden', note === '');

  install.classList.toggle('hidden', u.phase !== 'downloaded');
  download.classList.toggle('hidden', !(u.phase === 'unsupported' && Boolean(u.downloadUrl)));
  // Nothing to re-check while a check or a download is already in flight, and
  // nothing to check at all where updates do not apply.
  check.disabled = u.phase === 'checking' || u.phase === 'downloading' || u.phase === 'unsupported';
}

bridge.onLogs(appendLogs);
bridge.onStatus(render);
bridge.onUpdate(renderUpdate);
bridge.onUnauthorized(() => {
  setMsg($('pairMsg'), 'Bu cihazın yetkisi kaldırıldı. Panelden yeni bir kod alıp tekrar bağlayın.', 'bad');
});

void (async () => {
  const status = await bridge.getStatus();
  render(status);
  // Dev builds default the filter to debug — that's the point of running dev.
  if (status.env !== 'production') $<HTMLSelectElement>('logLevelFilter').value = 'debug';
  logEntries = await bridge.getLogs();
  renderLogs();
  await refreshPrinters();

  // Ask on load rather than waiting for a push: the window can be closed and
  // reopened long after the status last changed.
  const update = await bridge.getUpdateStatus();
  if (update.ok) renderUpdate(update.data);

  await bridge.probe();
})();
