/**
 * Mirrors the backend's `Station` enum — a value it can send that we cannot
 * route would sit DISPATCHED and be redelivered forever.
 *
 * THE LIST IS THE DEFINITION, and the type is derived from it, because the two
 * drifting apart is not hypothetical: 0.1.2 typed three stations while the job
 * guard accepted two, so every cashier receipt was dropped as "malformed job
 * payload" and the queue's pump loop would not have resumed one anyway. Adding
 * a station means editing this array; nothing else keeps its own copy.
 *
 * The renderer declares its own because it is a plain script with no module
 * loader — see src/renderer/index.ts.
 */
export const STATIONS = ['BAR', 'KITCHEN', 'CASHIER'] as const;

export type Station = (typeof STATIONS)[number];

export function isStation(value: unknown): value is Station {
  return typeof value === 'string' && (STATIONS as readonly string[]).includes(value);
}

export type AppEnv = 'development' | 'staging' | 'production';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One line of the in-app log viewer. `id` is monotonic per process. */
export interface LogEntry {
  id: number;
  at: string; // ISO
  level: LogLevel;
  message: string;
}

export type ConnectionState = 'OFFLINE' | 'CONNECTING' | 'CONNECTED' | 'UNPAIRED';

/** Named ESC/POS code pages. Value = argument to `ESC t n`. */
export const CODEPAGES: Record<string, number> = {
  // Epson TM-series character code tables.
  CP437: 0,
  CP850: 2,
  CP857: 13, // Turkish — default
  CP858: 19,
  ISO8859_9: 47,
  CP1254: 48,
};

export type CodepageName = keyof typeof CODEPAGES;

/** iconv-lite encoding name for each code page. */
export const CODEPAGE_ENCODING: Record<string, string> = {
  CP437: 'cp437',
  CP850: 'cp850',
  CP857: 'cp857',
  CP858: 'cp858',
  ISO8859_9: 'iso-8859-9',
  CP1254: 'win1254',
};

export type PrinterTarget =
  | { kind: 'network'; host: string; port: number }
  | { kind: 'spooler'; printerName: string };

export interface PrinterConfig {
  target: PrinterTarget;
  codepage: string; // key of CODEPAGES
  /** Characters per line: 42 for 80mm, 32 for 58mm. */
  width: 32 | 42 | 48;
  /** Cut paper after each ticket. */
  cut: boolean;
}

export interface TicketItem {
  qty: number;
  name: string;
  note?: string;
  options?: string[];
}

export interface TicketModel {
  kind: 'ORDER' | 'REPRINT' | 'CANCELLATION';
  station: Station;
  orderNo: string;
  tableName?: string;
  waiterName?: string;
  createdAt: string; // ISO
  items: TicketItem[];
  footer?: string;
}

export interface PrintJob {
  jobId: string;
  station: Station;
  copies: number;
  escpos?: string; // base64 pre-rendered bytes (preferred)
  content?: TicketModel; // structured fallback
  codepage?: string; // overrides printer config
}

export interface JobAck {
  jobId: string;
  status: 'printed' | 'failed';
  error?: string;
  attempts: number;
}

/**
 * What the update section is allowed to say.
 *
 * `unsupported` is a first-class state, not an error: macOS builds are unsigned
 * and genuinely cannot install their own updates, and a screen that pretends
 * otherwise — a spinner that never resolves, a silent "up to date" — is worse
 * than one that says so and offers the download page.
 */
export type UpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  /** The version running right now. */
  currentVersion: string;
  /** The version on the other end, once known. */
  newVersion?: string;
  /** 0–100 while downloading. */
  percent?: number;
  /** Why a check failed, or why updates are unsupported here. */
  detail?: string;
  /** Last completed check, ISO. Absent until one finishes. */
  checkedAt?: string;
  /** Where to get it by hand when the app cannot update itself. */
  downloadUrl?: string;
}

export interface DeviceInfo {
  hostname: string;
  platform: string;
  arch: string;
  appVersion: string;
}

export interface PairResponse {
  deviceToken: string;
  deviceId: string;
  tenantId: string;
  branchId: string;
  tenantName: string;
  branchName: string;
}

export interface AgentConfig {
  apiBaseUrl: string;
  wsUrl: string;
  deviceName: string;
  printers: Partial<Record<Station, PrinterConfig>>;
  pairing?: Omit<PairResponse, 'deviceToken'>;
  autostart: boolean;
  /** Kablolu yazarkasa (Hugin PC Link). Tanımlı değilse ÖKC yolu kapalıdır. */
  okc?: OkcConfig;
  /**
   * Ödeme köprüsü eşleştirmesi.
   *
   * Yazıcı eşleştirmesinden AYRI: yazıcı ajanı bir `Printer` satırıdır, köprü
   * bir `Terminal`. Aynı bilgisayarda çalışsalar bile ayrı eşleştirilir; birini
   * iptal etmek diğerini düşürmemeli.
   */
  bridge?: BridgePairing;
}

/** Köprü kimliği. Anahtar burada DEĞİL — safeStorage ile ayrı dosyada. */
export interface BridgePairing {
  deviceId: string;
  terminalId: string;
  terminalLabel: string;
  tenantName: string;
}

/**
 * Kafedeki yazarkasanın adresi.
 *
 * TEK CİHAZ, bilerek: ÖKC bir kasaya bağlıdır ve o kasada bir tane bulunur.
 * Yazıcılar istasyona göre çoğalır (bar, mutfak, kasa) ama mali belge kesen
 * cihaz tek bir mükellefe ait tek bir kayıt cihazıdır.
 */
export interface OkcConfig {
  /** Yalnızca özel ağ aralığı — bkz. `pclink.ts` `isPrivateHost`. */
  host: string;
  port: number;
  /**
   * Cihaz sertifikasının SHA-256 parmak izi. İlk başarılı bağlantıda öğrenilir
   * ve sonrasında EŞLEŞMEK ZORUNDA: cihaz kendinden imzalı sertifika sunduğu
   * için zincir doğrulaması işe yaramıyor, "aynı cihaz mı" sorusu bununla
   * cevaplanıyor.
   */
  fingerprint?: string;
  /** Kasada görünen ad. */
  label?: string;
  /**
   * `X-HardwareId` — cihazın çağıranı tanımak için ZORUNLU tuttuğu başlık.
   *
   * Boş bırakılırsa makinenin kendi adı gönderiliyor. Doküman bu başlığı
   * opsiyonel gösteriyor ama saha cihazı başlıksız her isteği reddediyor —
   * bkz. `pclink.ts`.
   */
  hardwareId?: string;
  /**
   * `X-SoftwareId` — PC Link uygulamasına girilen VKN. Zorunlu ve birebir
   * eşleşmeli; boşsa istek hiç gönderilmiyor (bkz. `okc.ts` sağlık kontrolü).
   */
  softwareId?: string;
  /**
   * Cihazın sicil numarası, `X-SerialNo` başlığında gider.
   *
   * `GET /v1/settings` döndürüyor; bilinmiyorsa başlık hiç gönderilmiyor.
   */
  serialNo?: string;
}

export interface OkcHealth {
  /** Cihaz ayarlandı mı. `false` ise ÖKC yolu hiç kurulmamış demektir. */
  configured: boolean;
  ok?: boolean;
  /** Cihazın kendi durumu: `IDLE` ya da `DOC`. */
  state?: string;
  /** Cihazda yarım kalmış bir belge var mı. */
  hasOpenDocument?: boolean;
  /** Ajanda kapatılmayı bekleyen satış varsa kimliği. */
  pendingSale?: string;
  error?: string;
  checkedAt?: string;
}

/** Backend'in gönderdiği satış emri. Belge backend'de kurulur, ajan taşır. */
export interface OkcSaleRequest {
  saleId: string;
  /** `PUT /v1/documents/{id}` gövdesi — ajan için OPAK. */
  document: Record<string, unknown>;
}

/**
 * Satışın sonucu.
 *
 * `UNKNOWN` birinci sınıf bir durumdur, hata değil: cevabı kaybolmuş bir satış
 * çekilmiş olabilir ve onu `DECLINED` yazmak, alınmış parayı yok saymaktır.
 */
export interface OkcSaleResult {
  saleId: string;
  status: 'APPROVED' | 'DECLINED' | 'UNKNOWN';
  /** `ZZZZ_NNNN` — mali fişin kimliği. */
  receiptNo?: string;
  documentId?: string;
  totals?: Record<string, string>;
  error?: string;
  /** Cihazın `ERR_*` kodu, geldiyse. */
  code?: string;
}

/** What the settings window renders. */
export interface StatusSnapshot {
  connection: ConnectionState;
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
  /** Köprü soketi ayakta mı. Yazıcı bağlantısından bağımsız bir sorudur. */
  bridgeConnected: boolean;
}

/** WS wire protocol, agent <-> gateway. */
/**
 * `/agent` kanalı YALNIZCA FİŞ taşır.
 *
 * ÖKC satışı bilerek burada değil: o, `/bridge` üzerinden yürüyor. İki kanalın
 * da aynı işi iddia etmesi, aynı satışın iki yoldan gelebilmesi demekti — ve
 * mükerrer bir satış emri, müşteriden iki kez para çekmektir.
 */
export type ServerMessage =
  | { type: 'job'; payload: PrintJob }
  | { type: 'revoked'; reason?: string }
  | { type: 'pong' };

export type ClientMessage =
  | { type: 'job.ack'; payload: JobAck }
  | { type: 'ping' }
  | { type: 'hello'; payload: DeviceInfo & { queued: number } };
