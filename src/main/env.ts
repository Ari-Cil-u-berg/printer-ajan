import fs from 'node:fs';
import path from 'node:path';

export type AppEnv = 'development' | 'staging' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface EnvConfig {
  env: AppEnv;
  apiBaseUrl: string;
  wsUrl: string;
  logLevel: LogLevel;
  /** Auto-update only makes sense against a real release feed. */
  autoUpdate: boolean;
  /** Mirror log lines to stdout. */
  logToConsole: boolean;
  /** Open devtools with the settings window. */
  devtools: boolean;
}

const PRESETS: Record<AppEnv, Omit<EnvConfig, 'env'>> = {
  development: {
    apiBaseUrl: 'http://localhost:8787',
    wsUrl: 'ws://localhost:8787/agent',
    logLevel: 'debug',
    autoUpdate: false,
    logToConsole: true,
    devtools: false,
  },
  staging: {
    apiBaseUrl: 'https://staging-api.ariadisyon.com',
    wsUrl: 'wss://staging-api.ariadisyon.com/agent',
    logLevel: 'debug',
    autoUpdate: true,
    logToConsole: true,
    devtools: false,
  },
  production: {
    apiBaseUrl: 'https://api.ariadisyon.com',
    wsUrl: 'wss://api.ariadisyon.com/agent',
    logLevel: 'info',
    autoUpdate: true,
    logToConsole: false,
    devtools: false,
  },
};

/** Electron is required lazily so this module also loads under plain node (tests). */
function isPackaged(): boolean {
  try {
    return (require('electron') as typeof import('electron')).app.isPackaged;
  } catch {
    return false;
  }
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/**
 * Loads .env files in dev only — a packaged app must be configured through real
 * environment variables, never a file next to the installed binary.
 * Precedence: real env > .env.<env>.local > .env.local > .env.<env> > .env
 */
function loadDotenvFiles(env: AppEnv): void {
  if (isPackaged()) return;
  const roots = [path.resolve(__dirname, '..', '..'), process.cwd()];
  const names = [`.env.${env}.local`, '.env.local', `.env.${env}`, '.env'];
  for (const root of roots) {
    for (const name of names) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(root, name), 'utf8');
      } catch {
        continue;
      }
      for (const [k, v] of Object.entries(parseDotenv(text))) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
    }
  }
}

function normalizeEnvName(raw: string | undefined): AppEnv | null {
  const v = (raw ?? '').toLowerCase();
  if (v === 'development' || v === 'dev') return 'development';
  if (v === 'staging' || v === 'stage') return 'staging';
  if (v === 'production' || v === 'prod') return 'production';
  return null;
}

/**
 * Written by scripts/write-build-env.mjs at package time — it is how a staging
 * installer knows it is staging without anyone setting a variable on the café PC.
 */
function bakedEnvName(): AppEnv | null {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'build-env.json'), 'utf8');
    return normalizeEnvName((JSON.parse(raw) as { env?: string }).env);
  } catch {
    return null;
  }
}

function resolveEnvName(): AppEnv {
  return (
    normalizeEnvName(process.env.ARI_ENV) ??
    normalizeEnvName(process.env.NODE_ENV) ??
    bakedEnvName() ??
    (isPackaged() ? 'production' : 'development')
  );
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function level(value: string | undefined, fallback: LogLevel): LogLevel {
  const v = (value ?? '').toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : fallback;
}

/**
 * In production the endpoints are NOT overridable, and that is a security
 * control rather than a convenience call.
 *
 * The agent holds a device token and prints every order that passes through a
 * café. Anyone who can set an environment variable for that process — a
 * modified shortcut, a login script, malware running as the same user — could
 * otherwise point a till at their own server: they would receive the tickets,
 * and they would receive the device token the moment somebody re-paired.
 * Silent, and invisible from the UI.
 *
 * Dev and staging keep the override, because that is what they are for. The
 * escape hatch in production is `ARI_ALLOW_ENDPOINT_OVERRIDE=1`, which is
 * logged loudly: support may need it once, an attacker gains nothing quiet.
 */
function endpoints(env: AppEnv, preset: Omit<EnvConfig, 'env'>): { apiBaseUrl: string; wsUrl: string } {
  const requested = {
    apiBaseUrl: (process.env.ARI_API_URL || preset.apiBaseUrl).replace(/\/$/, ''),
    wsUrl: process.env.ARI_WS_URL || preset.wsUrl,
  };
  const overridden =
    requested.apiBaseUrl !== preset.apiBaseUrl.replace(/\/$/, '') || requested.wsUrl !== preset.wsUrl;

  if (env === 'production' && overridden && !bool(process.env.ARI_ALLOW_ENDPOINT_OVERRIDE, false)) {
    warnings.push('endpoint override ignored in production');
    return { apiBaseUrl: preset.apiBaseUrl, wsUrl: preset.wsUrl };
  }

  // A plaintext endpoint outside development would put the device token on the
  // wire in the clear. Refuse it rather than degrade quietly.
  const insecure =
    env !== 'development' &&
    (/^http:\/\//i.test(requested.apiBaseUrl) || /^ws:\/\//i.test(requested.wsUrl));
  if (insecure) {
    warnings.push(`insecure endpoint rejected in ${env}`);
    return { apiBaseUrl: preset.apiBaseUrl, wsUrl: preset.wsUrl };
  }

  return requested;
}

/**
 * Collected during `build()` and drained by the main process once logging is up
 * — this module is imported BY the logger, so it cannot log for itself.
 */
const warnings: string[] = [];

export function takeEnvWarnings(): string[] {
  return warnings.splice(0, warnings.length);
}

function build(): EnvConfig {
  const env = resolveEnvName();
  loadDotenvFiles(env);
  const preset = PRESETS[env];
  return {
    env,
    ...endpoints(env, preset),
    logLevel: level(process.env.ARI_LOG_LEVEL, preset.logLevel),
    autoUpdate: bool(process.env.ARI_AUTO_UPDATE, preset.autoUpdate),
    logToConsole: bool(process.env.ARI_LOG_CONSOLE, preset.logToConsole),
    devtools: bool(process.env.ARI_DEVTOOLS, preset.devtools),
  };
}

let cached: EnvConfig | null = null;

export function envConfig(): EnvConfig {
  return (cached ??= build());
}

export function isDev(): boolean {
  return envConfig().env !== 'production';
}
