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
  /** `X-SerialNo` — boşsa cihazdan öğrenilir, elle de girilebilir. */
  serialNo?: string;
  /** `X-HardwareId` — cihazın etiketindeki Remark kodu. */
  hardwareId?: string;
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

type ConnState = 'OFFLINE' | 'CONNECTING' | 'CONNECTED' | 'UNPAIRED';

/** Bir panel yazıcı kaydı, kendi koduyla eşleşmiş. `shared/types.ts` PairingView. */
interface PairingView {
  deviceId: string;
  printerName: string;
  stations: Station[];
  tenantName: string;
  branchName: string;
  pairedAt: string;
  local?: PrinterConfig;
  legacyStationMap?: boolean;
  connection: ConnState;
  health?: { ok: boolean; checkedAt: string; error?: string };
}

interface StatusSnapshot {
  pairings: PairingView[];
  connection: ConnState;
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

interface UsbPrinterHint {
  name: string;
  driverOk: boolean;
}

/**
 * Windows'un kendi sanal yazıcıları — fiş basmazlar. Listede en alta ve
 * ayrı grupta durur; tek başlarına görünüyorlarsa asıl yazıcının sürücüsü
 * kurulmamış demektir.
 */
const VIRTUAL_PRINTER = /onenote|xps|pdf|fax|faks|send to|gönder|anydesk|teamviewer|snagit|microsoft print/i;

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

/** `okc:discover` sonucu — ayrıntı için `shared/types.ts`. */
interface OkcIdentityProbe {
  accepted: string | null;
  tried: { candidate: string; label: string; ok: boolean; error?: string }[];
  deviceTaxId?: string;
}

/** `okc:diagnose` sonucu — ayrıntı için `shared/types.ts`. */
interface OkcDiagnostics {
  rows: {
    label: string;
    endpoint: string;
    headers: Record<string, string>;
    httpStatus: number;
    ok: boolean;
    code?: string;
    message?: string;
  }[];
  accepted: string | null;
  deviceTaxId?: string;
  deviceSerialNo?: string;
}

interface AgentBridge {
  getStatus(): Promise<StatusSnapshot>;
  onStatus(cb: (s: StatusSnapshot) => void): void;
  onUnauthorized(cb: (printerName?: string) => void): void;
  pair(code: string): Promise<Result<StatusSnapshot>>;
  unpair(deviceId?: string): Promise<Result<StatusSnapshot>>;
  setPairingPrinter(deviceId: string, printer: PrinterConfig | null): Promise<Result<StatusSnapshot>>;
  testPairingPrint(deviceId: string): Promise<Result<boolean>>;
  listPrinters(): Promise<Result<DiscoveredPrinter[]>>;
  scanNetwork(): Promise<Result<DiscoveredPrinter[]>>;
  usbPrinterHints(): Promise<Result<UsbPrinterHint[]>>;
  setPrinter(station: Station, printer: PrinterConfig | null): Promise<Result<StatusSnapshot>>;
  testPrint(station: Station): Promise<Result<boolean>>;
  probe(): Promise<Result<StatusSnapshot>>;
  setOkc(config: OkcConfig | null): Promise<Result<StatusSnapshot>>;
  testOkc(): Promise<Result<OkcHealth>>;
  retryOkc(): Promise<Result<OkcSaleResult | null>>;
  cancelOkc(): Promise<Result<{ ok: boolean; error?: string }>>;
  discoverOkcIdentity(extra?: string): Promise<Result<OkcIdentityProbe>>;
  /** Bu bilgisayarın MAC adresleri — `X-HardwareId` kutusundaki düğme için. */
  localHardwareIds(): Promise<Result<{ value: string; bare: string; iface: string }[]>>;
  /** Cihaza hangi kimlik başlıklarını istediğini sorar. Salt okunur. */
  diagnoseOkc(): Promise<Result<OkcDiagnostics>>;
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
/** Sürücüsüz USB cihaz ipuçları; yalnızca gerçek yazıcı bulunamadığında sorulur. */
let usbHints: UsbPrinterHint[] = [];
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
  renderPairings(s);
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

  // Her eşleşme bir yazıcı; eski (istasyonlu) eşleşme ise istasyon başına.
  const legacy = s.pairings.some((p) => p.legacyStationMap);
  const modern = s.pairings.filter((p) => !p.legacyStationMap);
  const legacyConfigured = legacy ? STATIONS.filter((st) => s.printers[st]) : [];
  const configuredCount = modern.filter((p) => p.local).length + legacyConfigured.length;
  const totalCount = modern.length + legacyConfigured.length;
  const healthyCount =
    modern.filter((p) => p.local && p.health?.ok).length +
    legacyConfigured.filter((st) => s.printerHealth[st]?.ok).length;
  const configured = { length: totalCount };
  const healthy = { length: healthyCount };
  const printerEl = $('sPrinters');
  if (totalCount === 0) {
    printerEl.textContent = 'Seçilmedi';
    printerEl.className = 'metric-value warn';
  } else if (configuredCount < totalCount) {
    printerEl.textContent = `${totalCount - configuredCount} yazıcı seçilmedi`;
    printerEl.className = 'metric-value warn';
  } else {
    printerEl.textContent = `${healthyCount}/${totalCount} hazır`;
    printerEl.className = `metric-value ${healthyCount === totalCount ? 'ok' : 'bad'}`;
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
  const serialInput = $<HTMLInputElement>('okcSerialNo');
  const hardwareInput = $<HTMLInputElement>('okcHardwareId');

  // Yazarken üstüne yazma — kullanıcı IP girerken durum yenilenirse alan
  // sıfırlanmamalı.
  if (document.activeElement !== hostInput) hostInput.value = s.okc?.host ?? '';
  if (document.activeElement !== portInput) portInput.value = String(s.okc?.port ?? 4443);
  if (document.activeElement !== labelInput) labelInput.value = s.okc?.label ?? '';
  if (document.activeElement !== softwareInput) softwareInput.value = s.okc?.softwareId ?? '';
  // Cihazdan okunmuş sicil de burada görünür: kurulumcu markanın verdiği
  // numarayla karşılaştırabilmeli, "eşleşmiyor" hatası tam bu farkı anlatıyor.
  if (document.activeElement !== serialInput) serialInput.value = s.okc?.serialNo ?? '';
  if (document.activeElement !== hardwareInput) hardwareInput.value = s.okc?.hardwareId ?? '';

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
    serialNo: $<HTMLInputElement>('okcSerialNo').value.trim(),
    hardwareId: $<HTMLInputElement>('okcHardwareId').value.trim(),
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

/**
 * "MAC getir" — kutunun içindeki düğme.
 *
 * Hugin'in PC Link dokümanı `X-HardwareId`'nin ne olduğunu söylüyor: her
 * endpointteki örnek değer bir MAC adresi (`AB:12:3F:14:EE`) ve TSM bölümü
 * "PC Donanım, ve cihaz arasındaki eşleşme (X-Hardwareid ile)" diyor. Yani
 * CİHAZIN değil, BU BİLGİSAYARIN kimliği.
 *
 * Kurulumcuya `ipconfig /all` çalıştırıp satır saydırmanın gerekçesi yok:
 * değer makinede duruyor.
 *
 * BİRDEN FAZLA OLABİLİR (Ethernet + Wi-Fi) ve hangisinin kayıtlı olduğunu
 * bilmiyoruz — düğme her basışta sıradakine geçiyor, iki yazımıyla birlikte
 * (`AB:12:3F:14:EE` ve ayraçsız). Mesaj hangi arayüzün gösterildiğini söylüyor
 * ki kurulumcu kabloyu takılı olanı seçebilsin.
 *
 * Cihaza HİÇ DOKUNMUYOR: cihaz kapalıyken de çalışıyor, ki keşifin
 * çalışamadığı tek an orası.
 */
let macIndex = 0;
$('okcMacBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('okcMacBtn');
  const input = $<HTMLInputElement>('okcHardwareId');
  btn.disabled = true;
  const res = await bridge.localHardwareIds();
  btn.disabled = false;

  if (!res.ok) return setMsg($('okcMsg'), res.error, 'bad');

  // Her MAC iki adaydır: noktalı ve ayraçsız. Cihazın hangisini kaydettiğini
  // bilmediğimiz için ikisi de gezilebilir olmalı.
  const options = res.data.flatMap((entry) => [
    { value: entry.value, label: `${entry.iface}` },
    { value: entry.bare, label: `${entry.iface}, ayraçsız` },
  ]);

  if (options.length === 0) {
    return setMsg(
      $('okcMsg'),
      'Bu bilgisayarda okunabilir bir MAC adresi bulunamadı — kablolu/kablosuz bağlantıyı kontrol edin.',
      'bad',
    );
  }

  const pick = options[macIndex % options.length];
  if (!pick) return;
  macIndex += 1;
  input.value = pick.value;

  setMsg(
    $('okcMsg'),
    options.length > 1
      ? `${pick.label}: ${pick.value} — kaydedip deneyin. Tutmazsa tekrar basın (${options.length} seçenek).`
      : `${pick.label}: ${pick.value} — "Kaydet ve bağlan" ile deneyin.`,
    'ok',
  );
});

/**
 * TANILAMA — "hiçbir aday olmadı"dan sonra kalan tek soru.
 *
 * Keşif bir DEĞER arıyor. Bu, cihazın hangi BAŞLIĞI hangi uçta aradığını
 * ölçüyor: aynı iki salt-okunur uca altı ayrı kimlik kombinasyonuyla bakıp
 * cihazın her biri için verdiği cevabı olduğu gibi gösteriyor.
 *
 * Çıktı KOPYALANABİLİR, çünkü bir sonraki adım çoğu zaman Hugin'e sormak ve
 * "eşleşmiyor diyor" cümlesiyle sorulan soru üç kez cevapsız kaldı. Cihazın
 * kendi cevap tablosuyla sorulan soru farklı bir soru.
 */
function formatDiagnostics(d: OkcDiagnostics): string {
  const lines: string[] = [];
  lines.push(`Cihaz VKN: ${d.deviceTaxId ?? 'okunamadı'}`);
  lines.push(`Cihaz sicil: ${d.deviceSerialNo ?? 'okunamadı'}`);
  lines.push('');
  for (const row of d.rows) {
    const sent = Object.entries(row.headers)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    const verdict = row.ok ? 'GEÇTİ' : `${row.code ?? 'hata'}: ${row.message ?? '—'}`;
    lines.push(
      `${row.ok ? '✓' : '✗'} ${row.label} → ${row.endpoint} · HTTP ${row.httpStatus} · ${verdict}`,
    );
    lines.push(`    gönderilen: ${sent || '(başlık yok)'}`);
  }
  return lines.join('\n');
}

$('okcDiagnoseBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('okcDiagnoseBtn');
  btn.disabled = true;
  setMsg($('okcMsg'), 'Cihaza hangi kimliği istediği soruluyor…');
  const res = await bridge.diagnoseOkc();
  btn.disabled = false;

  if (!res.ok) return setMsg($('okcMsg'), res.error, 'bad');

  const text = formatDiagnostics(res.data);
  $('okcDiagText').textContent = text;
  $('okcDiagBox').classList.remove('hidden');

  const { accepted, rows } = res.data;
  const anyOk = rows.some((row) => row.ok);
  setMsg(
    $('okcMsg'),
    accepted
      ? `Cihaz "${accepted}" kombinasyonunu kabul ediyor — aşağıdaki tabloya bakın.`
      : anyOk
        ? 'Bazı uçlar geçti, satış ucu geçmedi — tablo hangisinin nerede düştüğünü gösteriyor.'
        : 'Cihaz hiçbir kombinasyonu kabul etmedi. Bu, değerin değil AKTİVASYONUN eksik olduğuna işaret eder.',
    accepted ? 'ok' : 'bad',
  );
});

$('okcDiagCopyBtn').addEventListener('click', () => {
  void navigator.clipboard.writeText($('okcDiagText').textContent ?? '');
  setMsg($('okcMsg'), 'Tanılama çıktısı kopyalandı.', 'ok');
});

$('okcDiagHideBtn').addEventListener('click', () => {
  $('okcDiagBox').classList.add('hidden');
});

/**
 * KİMLİK KEŞFİ — tahmin etmeyi bırakıp cihaza soruyoruz.
 *
 * `X-HardwareId`'nin ne olması gerektiği hiçbir dokümanda yazmıyor ve üç ayrı
 * tahmin sahada çürüdü. Sonuç listesi tam da bu yüzden gösteriliyor: hiçbiri
 * tutmadığında cihazın her aday için ne dediği, bakılacak tek yer.
 */
$('okcDiscoverBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('okcDiscoverBtn');
  btn.disabled = true;
  setMsg($('okcMsg'), 'Cihazın kabul ettiği kimlik aranıyor…');
  const res = await bridge.discoverOkcIdentity(
    $<HTMLInputElement>('okcLegacyTaxId').value.trim(),
  );
  btn.disabled = false;
  if (!res.ok) return setMsg($('okcMsg'), res.error, 'bad');

  const { accepted, tried, deviceTaxId } = res.data;
  if (accepted) {
    const label = tried.find((t) => t.ok)?.label ?? '';
    setMsg(
      $('okcMsg'),
      `Cihaz kimliği bulundu (${label}) ve kaydedildi.` +
        (deviceTaxId ? ` Cihazın VKN'si: ${deviceTaxId}.` : ''),
      'ok',
    );
    return;
  }

  // Denenenleri cihazın kendi cümleleriyle gösteriyoruz: "hiçbiri olmadı"
  // tek başına, sıradaki adımı kimseye söylemiyor.
  const lines = tried.map((t) => `• ${t.label} (${t.candidate}): ${t.error ?? 'reddedildi'}`);
  setMsg(
    $('okcMsg'),
    `Hiçbir aday kabul edilmedi.\n${lines.join('\n')}`,
    'bad',
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

/**
 * Bu bilgisayara bağlı yazıcı kayıtları.
 *
 * Panelde her yazıcının KENDİ kurulum kodu var ve sunucu bir fişi yalnızca o
 * kodla eşleşmiş ajana veriyor. 0.3.21'e kadar ajan tek kod tutuyordu: kasada
 * iki yazıcı olan bir kafede ikincinin kodunu girecek yer yoktu ve onun fişleri
 * hiç basılmıyordu. Şimdi her kayıt ayrı bir kart, her kartın yerel yazıcısı ayrı.
 */
function renderPairings(s: StatusSnapshot): void {
  const host = $('pairings');
  host.innerHTML = '';
  const modern = s.pairings.filter((p) => !p.legacyStationMap);
  for (const pairing of modern) host.appendChild(pairingCard(pairing));
  $('pairingsEmpty').classList.toggle('hidden', s.pairings.length > 0);
}

function pairingCard(p: PairingView): HTMLElement {
  const stations = p.stations.map((st) => STATION_LABEL[st]).join(' · ');
  const [connText, connCls] = STATE_TEXT[p.connection];
  return printerCard({
    title: p.printerName,
    subtitle: `${stations || 'İstasyon yok'} · Sunucu: ${connText}`,
    subtitleTone: connCls,
    printer: p.local,
    health: p.health,
    onSave: (cfg) => bridge.setPairingPrinter(p.deviceId, cfg),
    onTest: () => bridge.testPairingPrint(p.deviceId),
    removeLabel: 'Bu yazıcıyı kaldır',
    onRemove: async () => {
      if (!confirm(`"${p.printerName}" bu bilgisayardan kaldırılsın mı? Fişleri buraya gelmez; tekrar eklemek için panelden yeni kod gerekir.`)) {
        return { ok: true, data: currentStatus as StatusSnapshot };
      }
      return bridge.unpair(p.deviceId);
    },
    clearSelection: () => bridge.setPairingPrinter(p.deviceId, null),
  });
}

/** Yalnızca 0.3.21'den taşınan eşleşme için: istasyona göre eski eşleme. */
function renderStations(s: StatusSnapshot): void {
  const legacy = s.pairings.find((p) => p.legacyStationMap);
  $('legacyStations').classList.toggle('hidden', !legacy);
  const host = $('stations');
  host.innerHTML = '';
  if (!legacy) return;
  $('legacyName').textContent = legacy.printerName;
  for (const station of STATIONS) {
    host.appendChild(
      printerCard({
        title: `${STATION_LABEL[station]} yazıcısı`,
        printer: s.printers[station],
        health: s.printerHealth[station],
        onSave: (cfg) => bridge.setPrinter(station, cfg),
        onTest: () => bridge.testPrint(station),
        removeLabel: 'Kaldır',
        onRemove: () => bridge.setPrinter(station, null),
      }),
    );
  }
}

interface PrinterCardOptions {
  title: string;
  subtitle?: string;
  subtitleTone?: string;
  printer: PrinterConfig | undefined;
  health: { ok: boolean; error?: string } | undefined;
  onSave(cfg: PrinterConfig): Promise<Result<StatusSnapshot>>;
  onTest(): Promise<Result<boolean>>;
  removeLabel: string;
  onRemove(): Promise<Result<StatusSnapshot>>;
  /** Yerel seçimi temizler ama eşleşmeyi bırakır. */
  clearSelection?(): Promise<Result<StatusSnapshot>>;
}

function printerCard(o: PrinterCardOptions): HTMLElement {
  const { printer, health } = o;
  const card = document.createElement('div');
  card.className = 'station';

  const title = document.createElement('h3');
  title.append(document.createTextNode(o.title));

  const badge = document.createElement('span');
  badge.className = 'badge';
  const badgeDot = document.createElement('span');
  const badgeText = document.createElement('span');
  if (!printer) {
    badgeDot.className = 'dot warn';
    badgeText.textContent = 'Yazıcı seçilmedi';
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

  if (o.subtitle) {
    const sub = document.createElement('p');
    sub.className = `help${o.subtitleTone ? ` ${o.subtitleTone}` : ''}`;
    sub.textContent = o.subtitle;
    card.appendChild(sub);
  }

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
  const spoolHint = document.createElement('p');
  spoolHint.className = 'help spool-hint';
  const refreshSpoolOptions = (): void => {
    spoolSelect.innerHTML = '';
    const names = discovered.filter((d) => d.kind === 'spooler').map((d) => d.printerName!);
    const current = printer?.target.kind === 'spooler' ? printer.target.printerName : '';
    if (current && !names.includes(current)) names.unshift(current);
    const real = names.filter((n) => !VIRTUAL_PRINTER.test(n));
    const virtual = names.filter((n) => VIRTUAL_PRINTER.test(n));
    // İlk seçenek bilerek boş: yoksa listenin başındaki OneNote sessizce seçiliyordu.
    spoolSelect.append(new Option(real.length > 0 ? '— Yazıcı seçin —' : '— Fiş yazıcısı bulunamadı —', ''));
    for (const n of real) spoolSelect.append(new Option(n, n));
    if (virtual.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Sanal yazıcılar (fiş basmaz)';
      for (const n of virtual) group.append(new Option(n, n));
      spoolSelect.append(group);
    }
    spoolSelect.value = current || '';

    if (real.length > 0) {
      spoolHint.textContent = '';
      spoolHint.classList.add('hidden');
      return;
    }
    const lines = [
      'Fiş yazıcınız listede yok: Windows\'ta yazıcı olarak kurulu değil. Yazıcının sürücüsünü kurun (XP-80 için Xprinter sürücüsü) — Ayarlar → Yazıcılar ve tarayıcılar\'da görünmeli — sonra "Kurulu yazıcıları yenile"ye basın.',
      'Yazıcının ağ kablosu varsa sürücüye gerek yok: Bağlantı → "Ağ yazıcısı (IP)" seçin.',
    ];
    const missing = usbHints.filter((h) => !h.driverOk).map((h) => h.name);
    const unqueued = usbHints.filter((h) => h.driverOk).map((h) => h.name);
    if (missing.length > 0) lines.push(`USB'de sürücüsü olmayan cihaz görüldü: ${missing.join(', ')}.`);
    else if (unqueued.length > 0) lines.push(`USB'de yazıcı bağlantısı görüldü (${unqueued.join(', ')}) ama yazıcı sürücüsü kurulmamış.`);
    spoolHint.textContent = lines.join(' ');
    spoolHint.classList.remove('hidden');
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
  card.appendChild(spoolHint);

  const applyTypeVisibility = (): void => {
    const isNet = typeSelect.value === 'network';
    netLabel.classList.toggle('hidden', !isNet);
    netRow.classList.toggle('hidden', !isNet);
    spoolLabel.classList.toggle('hidden', isNet);
    spoolSelect.classList.toggle('hidden', isNet);
    spoolHint.classList.toggle('hidden', isNet || spoolHint.textContent === '');
  };
  // USB'ye geçince listeyi tazele: sürücü az önce kurulmuş olabilir.
  typeSelect.addEventListener('change', () => {
    applyTypeVisibility();
    // Yalnızca bu kartın listesi tazelenir; bütün kartları yeniden çizmek bu seçimi sıfırlardı.
    if (typeSelect.value === 'spooler') void loadPrinters().then(refreshSpoolOptions);
  });
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
    if (target.kind === 'spooler' && !target.printerName) {
      setMsg(msg, 'Önce listeden fiş yazıcısını seçin.', 'bad');
      return;
    }
    const res = await o.onSave({
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
    const res = await o.onTest();
    testBtn.disabled = false;
    setMsg(
      msg,
      res.ok ? 'Test fişi gönderildi. Fişte bu yazıcının adı yazmalı; Türkçe harfleri kontrol edin.' : res.error,
      res.ok ? 'ok' : 'bad',
    );
  });

  const row = document.createElement('div');
  row.className = 'row';
  row.append(saveBtn, testBtn);

  if (o.clearSelection && printer) {
    const clearSel = document.createElement('button');
    clearSel.className = 'ghost';
    clearSel.textContent = 'Seçimi temizle';
    clearSel.addEventListener('click', async () => {
      const res = await o.clearSelection!();
      if (!res.ok) setMsg(msg, res.error, 'bad');
    });
    row.append(clearSel);
  }

  const removeBtn = document.createElement('button');
  removeBtn.className = 'ghost danger';
  removeBtn.textContent = o.removeLabel;
  removeBtn.addEventListener('click', async () => {
    const res = await o.onRemove();
    if (!res.ok) setMsg(msg, res.error, 'bad');
  });
  row.append(removeBtn);

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

/** Kurulu yazıcıları (ve gerekiyorsa USB ipuçlarını) okur; ekranı çizmez. */
async function loadPrinters(): Promise<boolean> {
  const res = await bridge.listPrinters();
  if (res.ok) {
    discovered = res.data;
    // Gerçek fiş yazıcısı yoksa Windows'a USB'de ne takılı olduğunu sor —
    // "sürücü kurulu değil" uyarısına cihazın adını eklemek için.
    const hasReal = discovered.some((d) => d.kind === 'spooler' && !VIRTUAL_PRINTER.test(d.printerName ?? ''));
    if (!hasReal) {
      const hints = await bridge.usbPrinterHints();
      usbHints = hints.ok ? hints.data : [];
    } else {
      usbHints = [];
    }
    return true;
  }
  return false;
}

async function refreshPrinters(): Promise<void> {
  if ((await loadPrinters()) && currentStatus) {
    renderPairings(currentStatus);
    renderStations(currentStatus);
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
    // İlk yazıcı eklendi: bu bilgisayardaki yazıcısını seçmek bir sonraki adım.
    showPanel('printers');
  } else {
    setMsg(msg, res.error, 'bad');
  }
});

$('code').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') $('pairBtn').click();
});

$('unpairBtn').addEventListener('click', async () => {
  if (!confirm('Bu bilgisayardaki TÜM yazıcılar kafeden ayrılsın mı? Tekrar bağlamak için her yazıcıya panelden yeni kod gerekir.')) return;
  const res = await bridge.unpair();
  if (res.ok) render(res.data);
});

/** Bir yazıcı daha ekle — panelde her yazıcının kendi kurulum kodu var. */
$('addPairBtn').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('addCode');
  const btn = $<HTMLButtonElement>('addPairBtn');
  const msg = $('addPairMsg');
  btn.disabled = true;
  setMsg(msg, 'Ekleniyor…');
  const res = await bridge.pair(input.value);
  btn.disabled = false;
  if (!res.ok) return setMsg(msg, res.error, 'bad');
  input.value = '';
  const added = res.data.pairings[res.data.pairings.length - 1];
  setMsg(msg, added ? `"${added.printerName}" eklendi. Aşağıdan bu bilgisayardaki yazıcısını seçin.` : 'Eklendi.', 'ok');
  render(res.data);
});

$('addCode').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') $('addPairBtn').click();
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
bridge.onUnauthorized((printerName) => {
  const text = printerName
    ? `"${printerName}" yazıcısının yetkisi panelden kaldırıldı. Tekrar eklemek için panelden yeni kod alın.`
    : 'Bu cihazın yetkisi kaldırıldı. Panelden yeni bir kod alıp tekrar bağlayın.';
  setMsg($('pairMsg'), text, 'bad');
  setMsg($('addPairMsg'), text, 'bad');
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
