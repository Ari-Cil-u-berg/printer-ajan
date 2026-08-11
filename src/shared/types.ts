/** Mirrors the backend's `Station` enum — a value it can send that we cannot
 *  route would sit DISPATCHED and be redelivered forever. */
export type Station = 'BAR' | 'KITCHEN' | 'CASHIER';

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
}

/** WS wire protocol, agent <-> gateway. */
export type ServerMessage =
  | { type: 'job'; payload: PrintJob }
  | { type: 'revoked'; reason?: string }
  | { type: 'pong' };

export type ClientMessage =
  | { type: 'job.ack'; payload: JobAck }
  | { type: 'ping' }
  | { type: 'hello'; payload: DeviceInfo & { queued: number } };
