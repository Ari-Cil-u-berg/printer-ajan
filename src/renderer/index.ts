/**
 * Ayar penceresi. Bundler yok: düz betik, ana süreçle yalnızca preload'un
 * açtığı `agent` köprüsü üzerinden konuşur. Tipler bu yüzden burada tekrar
 * tanımlanıyor — `import` edecek bir modül yükleyici yok.
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

/**
 * `shared/types.ts`'in kopyası — renderer izole derleniyor ve ana süreç
 * tiplerini içe aktarmıyor. Alan eklerken İKİ TARAFI da güncelleyin; burada
 * eksik kalan bir alan, formda doldurulup sessizce kaybolur.
 */
interface OkcConfig {
  host: string;
  port: number;
  fingerprint?: string;
  label?: string;
  /** `X-SoftwareId` — PC Link'e girilen VKN. Birebir eşleşmeli. */
  softwareId?: string;
  /** `X-HardwareId` — cihazda kayıtlı kimlik. Boşsa VKN kullanılır. */
  hardwareId?: string;
  /** `X-SerialNo` — boşsa cihazdan öğrenilir, elle de girilebilir. */
  serialNo?: string;
}
interface OkcHealth {
  configured: boolean;
  ok?: boolean;
  state?: string;
  hasOpenDocument?: boolean;
  openDocumentId?: string;
  pendingSale?: string;
  error?: string;
  checkedAt?: string;
}
interface BridgePairing {
  deviceId: string
  terminalId: string
  terminalLabel: string
  tenantName: string
}
interface OkcSaleResult {
  saleId: string;
  status: 'APPROVED' | 'DECLINED' | 'UNKNOWN';
  receiptNo?: string;
  documentId?: string;
  error?: string;
  code?: string;
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
  okc?: OkcConfig;
  okcHealth: OkcHealth;
  lastSale?: OkcSaleResult & { at: string };
  bridge?: BridgePairing;
  bridgeConnected: boolean;
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
  setOkc(config: OkcConfig | null): Promise<Result<StatusSnapshot>>;
  testOkc(): Promise<Result<OkcHealth>>;
  retryOkc(): Promise<Result<OkcSaleResult | null>>;
  cancelOkc(): Promise<Result<{ ok: boolean; error?: string }>>;
  pairBridge(code: string): Promise<Result<StatusSnapshot>>;
  unpairBridge(): Promise<Result<StatusSnapshot>>;
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
/** DOM'u sınırlı tut — asıl kaydırma tamponu ana süreçte. */
const LOG_VIEW_MAX = 1000;

let discovered: DiscoveredPrinter[] = [];
let currentStatus: StatusSnapshot | null = null;
let logEntries: LogEntry[] = [];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function setMsg(el: HTMLElement, text: string, kind: 'ok' | 'bad' | '' = ''): void {
  el.textContent = text;
  el.className = `msg${kind ? ` ${kind}` : ''}`;
}

function timeOf(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

// --- gezinme ---------------------------------------------------------------

/**
 * Sekmeler. Panel değiştirmek DOM'u yeniden kurmaz, yalnızca görünürlüğü
 * değiştirir: günlük görüntüleyicinin kaydırma konumu ve yazıcı formlarındaki
 * yazılmış ama kaydedilmemiş değerler sekme değişince kaybolmamalı.
 */
function showPanel(name: string): void {
  document.querySelectorAll<HTMLElement>('.navitem').forEach((item) => {
    item.classList.toggle('is-active', item.dataset['panel'] === name);
  });
  document.querySelectorAll<HTMLElement>('.panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset['panel'] === name);
  });
}

document.querySelectorAll<HTMLElement>('.navitem').forEach((item) => {
  item.addEventListener('click', () => showPanel(item.dataset['panel'] ?? 'status'));
});

// --- çizim -----------------------------------------------------------------

function render(s: StatusSnapshot): void {
  currentStatus = s;

  // Eşleşmemiş bir ajanda ayarların anlamı yok; kurulum ekranı tek başına durur.
  $('onboarding').classList.toggle('hidden', s.paired);
  $('app').classList.toggle('hidden', !s.paired);
  $('obVersion').textContent = s.appVersion;
  $('obEnv').textContent = ENV_LABEL[s.env];

  const [text, cls] = STATE_TEXT[s.connection];
  $('stateText').textContent = text;
  $('dot').className = `dot ${cls}`;

  $('place').textContent = s.paired && s.branchName
    ? `${s.tenantName ?? ''} — ${s.branchName}`
    : 'Henüz eşleştirilmedi';
  $('deviceLine').textContent = `${s.deviceName} · sürüm ${s.appVersion}`;

  const badge = $('envBadge');
  badge.className = `env ${s.env}${s.env === 'production' ? ' hidden' : ''}`;
  badge.textContent = s.env.toUpperCase();

  renderMetrics(s);
  renderStatusPanel(s);
  renderStations(s);
  renderOkc(s);
}

/**
 * Üç ölçü: kuyruk, yazıcılar, yazarkasa.
 *
 * Ekranın açılışta cevapladığı soru "her şey yolunda mı?" — o cevabı bulmak
 * için üç sekmeyi gezmek gerekiyorsa, kimse gezmez ve sorun ancak servis
 * sırasında fark edilir.
 */
function renderMetrics(s: StatusSnapshot): void {
  $('sQueue').textContent = String(s.queued);
  $('sQueue').className = `metric-value${s.queued > 0 ? ' warn' : ''}`;

  const configured = STATIONS.filter((st) => s.printers[st]);
  const healthy = configured.filter((st) => s.printerHealth[st]?.ok);
  const printerEl = $('sPrinters');
  if (configured.length === 0) {
    printerEl.textContent = 'Seçilmedi';
    printerEl.className = 'metric-value warn';
  } else {
    printerEl.textContent = `${healthy.length}/${configured.length} hazır`;
    printerEl.className = `metric-value ${healthy.length === configured.length ? 'ok' : 'bad'}`;
  }
  navDot('navDotPrinters', configured.length === 0 ? 'warn' : healthy.length === configured.length ? 'ok' : 'bad');

  const okcEl = $('sOkc');
  const h = s.okcHealth;
  if (!h.configured) {
    okcEl.textContent = 'Yok';
    okcEl.className = 'metric-value';
    navDot('navDotOkc', '');
  } else if (h.pendingSale) {
    okcEl.textContent = 'Bekleyen fiş';
    okcEl.className = 'metric-value bad';
    navDot('navDotOkc', 'bad');
  } else if (h.ok) {
    okcEl.textContent = h.hasOpenDocument ? 'Açık belge' : 'Hazır';
    okcEl.className = `metric-value ${h.hasOpenDocument ? 'warn' : 'ok'}`;
    navDot('navDotOkc', h.hasOpenDocument ? 'warn' : 'ok');
  } else {
    okcEl.textContent = 'Ulaşılamıyor';
    okcEl.className = 'metric-value bad';
    navDot('navDotOkc', 'bad');
  }

  navDot('navDotStatus', s.connection === 'CONNECTED' ? 'ok' : s.connection === 'CONNECTING' ? 'warn' : 'bad');
}

function navDot(id: string, tone: string): void {
  $(id).className = `navdot${tone ? ` ${tone}` : ''}`;
}

function renderStatusPanel(s: StatusSnapshot): void {
  $('sEnv').textContent = `${ENV_LABEL[s.env]} · ${s.apiBaseUrl}`;
  $('pairedPlace').textContent = s.paired
    ? `${s.tenantName ?? ''} / ${s.branchName ?? ''}`
    : '—';

  $('sLast').textContent = s.lastJob
    ? `${STATION_LABEL[s.lastJob.station]} · ${s.lastJob.status}${s.lastJob.error ? ` (${s.lastJob.error})` : ''}`
    : '—';

  $('sLastSale').textContent = s.lastSale ? saleLine(s.lastSale) : '—';

  const nameInput = $<HTMLInputElement>('deviceName');
  if (document.activeElement !== nameInput) nameInput.value = s.deviceName;
  $<HTMLInputElement>('autostart').checked = s.autostart;
}

/** `UNKNOWN` ayrı yazılır: "başarısız" demek, çekilmiş olabilecek parayı yok saymaktır. */
function saleLine(sale: OkcSaleResult & { at: string }): string {
  const when = timeOf(sale.at);
  switch (sale.status) {
    case 'APPROVED':
      return `${when} · Fiş ${sale.receiptNo ?? '—'}`;
    case 'DECLINED':
      return `${when} · Kesilmedi${sale.error ? ` — ${sale.error}` : ''}`;
    default:
      return `${when} · Sonuç belirsiz${sale.error ? ` — ${sale.error}` : ''}`;
  }
}

// --- yazarkasa -------------------------------------------------------------

function renderOkc(s: StatusSnapshot): void {
  const hostInput = $<HTMLInputElement>('okcHost');
  const portInput = $<HTMLInputElement>('okcPort');
  const labelInput = $<HTMLInputElement>('okcLabel');
  const softwareInput = $<HTMLInputElement>('okcSoftwareId');
  const hardwareInput = $<HTMLInputElement>('okcHardwareId');
  const serialInput = $<HTMLInputElement>('okcSerialNo');

  // Yazarken üstüne yazma — kullanıcı IP girerken durum yenilenirse alan
  // sıfırlanmamalı.
  if (document.activeElement !== hostInput) hostInput.value = s.okc?.host ?? '';
  if (document.activeElement !== portInput) portInput.value = String(s.okc?.port ?? 4443);
  if (document.activeElement !== labelInput) labelInput.value = s.okc?.label ?? '';
  if (document.activeElement !== softwareInput) softwareInput.value = s.okc?.softwareId ?? '';
  if (document.activeElement !== hardwareInput) hardwareInput.value = s.okc?.hardwareId ?? '';
  // Cihazdan okunmuş sicil de burada görünür: kurulumcu markanın verdiği
  // numarayla karşılaştırabilmeli, "eşleşmiyor" hatası tam bu farkı anlatıyor.
  if (document.activeElement !== serialInput) serialInput.value = s.okc?.serialNo ?? '';

  const h = s.okcHealth;
  const stateEl = $('okcState');
  if (!h.configured) {
    stateEl.textContent = 'Tanımlanmadı';
  } else if (h.ok) {
    stateEl.textContent = `Bağlı${h.state ? ` (${h.state})` : ''}`;
  } else {
    stateEl.textContent = h.error ?? 'Ulaşılamıyor';
  }

  $('okcDoc').textContent = !h.configured ? '—' : h.hasOpenDocument ? 'Var' : 'Yok';
  $('okcChecked').textContent = timeOf(h.checkedAt);

  // Parmak izinin ilk 16 hanesi yeter: amaç okumak değil, "tanındı mı"
  // sorusunu cevaplamak.
  $('okcCert').textContent = s.okc?.fingerprint
    ? `${s.okc.fingerprint.slice(0, 17)}…`
    : 'Henüz tanınmadı';

  // Köprü: satış emrinin geleceği kanal. Yazıcı bağlantısından AYRI bir soru —
  // biri bağlıyken diğeri kopuk olabilir ve tek bir gösterge ikisini de yanlış
  // anlatır.
  $('bridgeState').textContent = !s.bridge
    ? 'Eşleştirilmemiş'
    : s.bridgeConnected
      ? 'Bağlı'
      : 'Bağlanıyor…'
  $('bridgeTerminal').textContent = s.bridge
    ? `${s.bridge.terminalLabel}${s.bridge.tenantName ? ` · ${s.bridge.tenantName}` : ''}`
    : '—'
  $('bridgePairRow').classList.toggle('hidden', Boolean(s.bridge))
  $('bridgeUnpairRow').classList.toggle('hidden', !s.bridge)

  // İKİ AYRI DURUM, tek kart:
  //   - `pendingSale`: gövdesini BİZ biliyoruz, tekrar denenebilir.
  //   - `openDocumentId`: cihazda açık ama bizde kaydı yok. Tekrar denenemez
  //     (ne göndereceğimizi bilmiyoruz), yalnızca iptal edilebilir.
  // İkincisini göstermemek, cihazın "uygun durumda değil" demesine sebep olan
  // belgeyi kasiyerden gizlemek olurdu — kurtarmanın tek yolu cihazın başına
  // gitmek olurdu.
  const pending = Boolean(h.pendingSale);
  const orphan = !pending && Boolean(h.openDocumentId);
  $('okcPendingCard').classList.toggle('hidden', !pending && !orphan);
  $('okcRetryBtn').classList.toggle('hidden', !pending);
  if (pending) {
    $('okcPendingText').textContent =
      'Bu ajanda kapatılamamış bir mali belge var. Ödeme alınmış olabilir — önce "Tekrar dene" deneyin, fiş kesilmediyse iptal edin. Yeni satış başlatmayın.';
  } else if (orphan) {
    $('okcPendingText').textContent =
      'Cihazda açık bir fiş duruyor ve bu yüzden yeni satış kabul etmiyor ("uygun durumda değil"). Bu fişi ajan başlatmadı, içeriğini bilmiyoruz — kapatmak için iptal edin.';
  }
}

$('okcSaveBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('okcSaveBtn');
  const msg = $('okcMsg');
  btn.disabled = true;
  setMsg(msg, 'Bağlanılıyor…');

  const res = await bridge.setOkc({
    host: $<HTMLInputElement>('okcHost').value.trim(),
    port: Number($<HTMLInputElement>('okcPort').value) || 4443,
    label: $<HTMLInputElement>('okcLabel').value.trim(),
    softwareId: $<HTMLInputElement>('okcSoftwareId').value.trim(),
    hardwareId: $<HTMLInputElement>('okcHardwareId').value.trim(),
    serialNo: $<HTMLInputElement>('okcSerialNo').value.trim(),
  });
  btn.disabled = false;

  if (!res.ok) return setMsg(msg, res.error, 'bad');
  const h = res.data.okcHealth;
  setMsg(
    msg,
    h.ok ? 'Yazarkasa bağlandı.' : h.error ?? 'Yazarkasaya ulaşılamadı.',
    h.ok ? 'ok' : 'bad',
  );
});

$('okcTestBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('okcTestBtn');
  btn.disabled = true;
  setMsg($('okcMsg'), 'Sınanıyor…');
  const res = await bridge.testOkc();
  btn.disabled = false;
  if (!res.ok) return setMsg($('okcMsg'), res.error, 'bad');
  setMsg(
    $('okcMsg'),
    res.data.ok ? `Cihaz yanıt verdi (${res.data.state ?? 'IDLE'}).` : res.data.error ?? 'Ulaşılamadı.',
    res.data.ok ? 'ok' : 'bad',
  );
});

$('okcClearBtn').addEventListener('click', async () => {
  const res = await bridge.setOkc(null);
  setMsg($('okcMsg'), res.ok ? 'Yazarkasa kaldırıldı.' : res.error, res.ok ? 'ok' : 'bad');
});

$('bridgePairBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('bridgePairBtn')
  const input = $<HTMLInputElement>('bridgeCode')
  btn.disabled = true
  setMsg($('bridgeMsg'), 'Eşleştiriliyor…')
  const res = await bridge.pairBridge(input.value)
  btn.disabled = false
  if (!res.ok) return setMsg($('bridgeMsg'), res.error, 'bad')
  input.value = ''
  setMsg($('bridgeMsg'), 'Eşleştirildi.', 'ok')
  render(res.data)
})

$('bridgeCode').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') $('bridgePairBtn').click()
})

$('bridgeUnpairBtn').addEventListener('click', async () => {
  const res = await bridge.unpairBridge()
  if (!res.ok) return setMsg($('bridgeMsg'), res.error, 'bad')
  setMsg($('bridgeMsg'), 'Eşleştirme kaldırıldı.')
  render(res.data)
})

$('okcRetryBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('okcRetryBtn');
  btn.disabled = true;
  setMsg($('okcPendingMsg'), 'Fiş tekrar kapatılmaya çalışılıyor…');
  const res = await bridge.retryOkc();
  btn.disabled = false;
  if (!res.ok) return setMsg($('okcPendingMsg'), res.error, 'bad');
  if (!res.data) return setMsg($('okcPendingMsg'), 'Bekleyen belge bulunamadı.');
  setMsg(
    $('okcPendingMsg'),
    res.data.status === 'APPROVED'
      ? `Fiş kesildi: ${res.data.receiptNo ?? '—'}`
      : res.data.error ?? 'Hâlâ kapatılamadı.',
    res.data.status === 'APPROVED' ? 'ok' : 'bad',
  );
});

$('okcCancelBtn').addEventListener('click', async () => {
  const res = await bridge.cancelOkc();
  if (!res.ok) return setMsg($('okcPendingMsg'), res.error, 'bad');
  setMsg(
    $('okcPendingMsg'),
    res.data.ok ? 'Belge iptal edildi.' : res.data.error ?? 'İptal edilemedi.',
    res.data.ok ? 'ok' : 'bad',
  );
});

// --- yazıcılar -------------------------------------------------------------

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

  const title = document.createElement('h3');
  title.append(document.createTextNode(`${STATION_LABEL[station]} yazıcısı`));

  const badge = document.createElement('span');
  badge.className = 'badge';
  const badgeDot = document.createElement('span');
  const badgeText = document.createElement('span');
  if (!printer) {
    badgeDot.className = 'dot';
    badgeText.textContent = 'Seçilmedi';
  } else if (!health) {
    badgeDot.className = 'dot warn';
    badgeText.textContent = 'Denetleniyor…';
  } else if (health.ok) {
    badgeDot.className = 'dot ok';
    badgeText.textContent = 'Hazır';
  } else {
    badgeDot.className = 'dot bad';
    badgeText.textContent = health.error ?? 'Ulaşılamıyor';
  }
  badge.append(badgeDot, badgeText);
  title.appendChild(badge);
  card.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'grid';

  const typeSelect = document.createElement('select');
  for (const [value, text] of [['network', 'Ağ yazıcısı (IP)'], ['spooler', 'Kurulu yazıcı (USB)']]) {
    typeSelect.append(new Option(text!, value!));
  }
  typeSelect.value = printer?.target.kind ?? 'network';
  grid.append(label('Bağlantı'), typeSelect);

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
  netRow.append(hostInput, portInput);
  const netLabel = label('IP ve port');
  grid.append(netLabel, netRow);

  const spoolSelect = document.createElement('select');
  const refreshSpoolOptions = (): void => {
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
  cutWrap.style.marginTop = '0';
  cutWrap.append(cutBox, document.createTextNode(' Fiş sonunda kağıdı kes'));
  grid.append(label('Kesici'), cutWrap);

  card.appendChild(grid);

  const applyTypeVisibility = (): void => {
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
    const res = await bridge.setPrinter(station, {
      target,
      codepage: cpSelect.value,
      width: Number(widthSelect.value) as 32 | 42 | 48,
      cut: cutBox.checked,
    });
    setMsg(msg, res.ok ? 'Kaydedildi.' : res.error, res.ok ? 'ok' : 'bad');
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
  clearBtn.className = 'ghost danger';
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

// --- günlükler -------------------------------------------------------------

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
    // `file://` sayfaları her zaman asenkron panoya erişemiyor — seçim yoluyla kopyala.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    setMsg($('logMsg'), ok ? 'Kopyalandı.' : 'Kopyalanamadı.', ok ? 'ok' : 'bad');
  }
}

// --- bağlama ---------------------------------------------------------------

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
    setMsg(msg, '');
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
  if (!res.ok) $('updateDetail').textContent = res.error;
});

$('updateDownloadBtn').addEventListener('click', () => {
  if (updateState?.downloadUrl) window.open(updateState.downloadUrl, '_blank');
});

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
 * Her zaman doğru olan tek satır ve yalnızca bir işe yaradığında görünen
 * düğmeler.
 *
 * Eski ekranda "Güncellemeleri denetle" hiçbir şey bildirmiyordu — tıklamak,
 * uygulama güncelken de indirme sürerken de denetim başarısızken de aynı
 * görünüyordu. Aşağıdaki her durum hangisi olduğunu söylüyor; `unsupported` da
 * kendini imzasız macOS derlemesinde sonsuza kadar dönen bir çarkla değil,
 * açıkça anlatıyor.
 */
function renderUpdate(u: UpdateStatus): void {
  updateState = u;
  const dot = $('updateDot');
  const text = $('updateText');
  const detail = $('updateDetail');
  const install = $('updateInstallBtn');
  const download = $('updateDownloadBtn');
  const check = $<HTMLButtonElement>('updateBtn');

  const checked = u.checkedAt ? `Son denetim: ${timeOf(u.checkedAt)}` : '';

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
  // Geliştirme derlemelerinde filtre debug'a düşer — dev çalıştırmanın amacı bu.
  if (status.env !== 'production') $<HTMLSelectElement>('logLevelFilter').value = 'debug';
  logEntries = await bridge.getLogs();
  renderLogs();
  await refreshPrinters();

  // Yüklenirken sor: pencere kapatılıp durum değiştikten çok sonra açılabilir.
  const update = await bridge.getUpdateStatus();
  if (update.ok) renderUpdate(update.data);

  await bridge.probe();
})();
