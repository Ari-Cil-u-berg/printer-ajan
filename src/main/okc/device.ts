import type { EventEmitter } from 'node:events';
import type {
  OkcConfig,
  OkcDiagnostics,
  OkcHealth,
  OkcIdentityProbe,
  OkcProtocol,
  OkcSaleRequest,
  OkcSaleResult,
} from '../../shared/types';
import { Gmp3OkcManager } from './okc-gmp3';
import { OkcManager } from './okc';

export interface DailyZResult {
  ok: boolean;
  report?: Record<string, unknown>;
  serialNo?: string;
  error?: string;
}

/**
 * Ajanın yazarkasadan istediği her şey — iki dil (PC Link, GMP-3) aynı yüzü
 * gösteriyor. Köprü, kasa ekranı ve IPC hangisiyle konuştuğunu bilmiyor; bilmesi
 * gereken tek yer bu dosyadaki seçim.
 */
export interface FiscalDevice extends EventEmitter {
  getConfig(): OkcConfig | undefined;
  setConfig(config: OkcConfig | undefined): void;
  getHealth(): OkcHealth;
  start(): void;
  stop(): void;
  refreshHealth(): Promise<OkcHealth>;
  sell(request: OkcSaleRequest): Promise<OkcSaleResult>;
  cancelSale(saleId: string): Promise<{ ok: boolean; error?: string }>;
  cancelPending(): Promise<{ ok: boolean; error?: string }>;
  retryPending(): Promise<OkcSaleResult | null>;
  dailyZ(): Promise<DailyZResult>;
  discoverIdentity(extra?: string[]): Promise<OkcIdentityProbe>;
  diagnose(): Promise<OkcDiagnostics>;
}

export function protocolOf(config: OkcConfig | undefined): OkcProtocol {
  return config?.protocol === 'gmp3' ? 'gmp3' : 'pclink';
}

export function createFiscalDevice(
  dataDir: string,
  config: OkcConfig | undefined,
  persist: (config: OkcConfig) => void,
): FiscalDevice {
  return protocolOf(config) === 'gmp3'
    ? new Gmp3OkcManager(dataDir, config, persist)
    : new OkcManager(dataDir, config, persist);
}
