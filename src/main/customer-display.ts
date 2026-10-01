import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from './logger';

const run = promisify(execFile);

/**
 * MÜŞTERİ EKRANI İZİNLERİ — kasa tarayıcısına, yalnızca POS kökeni için.
 *
 * NE: Chrome/Edge/Brave kurumsal politikaları (liste politikaları, yalnızca
 * kökene bakar — kaynak: chromium/components/policy/resources/templates/
 * policy_definitions/ContentSettings/*.yaml):
 *   WindowManagementAllowedForUrls    ikinci monitörü görüp pencereyi oraya
 *                                     yerleştirmek (Chrome 111+)
 *   PopupsAllowedForUrls              müşteri ekranı penceresini açmak
 *   AutomaticFullscreenAllowedForUrls dokunmadan tam ekran (Chrome 124+)
 * Sonuç: POS'ta "Müşteri ekranını aç" hiçbir şey sormadan ikinci ekranda tam
 * ekran açılır.
 *
 * NEDEN BİR KEZ "EVET" (UAC): ajan kullanıcı başına, yöneticisiz kurulu.
 * Windows, standart kullanıcının HKLM\SOFTWARE\Policies'e de
 * HKCU\Software\Policies'e de yazmasına izin vermez — kullanıcı kendi
 * politikasını değiştiremesin diye. Dünyada da yol bu: ya BT (GPO/Intune)
 * dağıtır ya kullanıcı bir kez yönetici onayı verir. Okumak yetki istemez;
 * durum her zaman sessizce okunur.
 *
 * GÜVENLİK — bu izin bir siteye "sormadan pencere + tam ekran" verir:
 *   - Köken birebir; joker yok, yol yok, kullanıcı:parola yok.
 *   - https zorunlu; http yalnızca yerel ağ kurulumu (localhost, özel IPv4, .local).
 *   - Köken sunucunun `/agent/info` cevabından gelir ve ajanın konuştuğu API
 *     ile aynı siteye ait olmalı — kötü niyetli bir cevap kasaya başka alan adı
 *     yazdıramaz.
 *   - Yetkili komut DOSYAYA YAZILMAZ: geçici bir .reg/.ps1, yazıldığı an ile
 *     yönetici olarak çalıştığı an arasında aynı kullanıcının başka bir süreci
 *     tarafından değiştirilebilir (yetki yükseltme). Betik `-EncodedCommand`
 *     ile doğrudan yetkili sürece verilir; içine yalnızca doğrulanmış köken girer.
 *   - execFile, kabuk yok.
 *   - Başkasının (BT'nin) girdisine dokunulmaz: yalnızca BİZİM eklediğimiz
 *     (anahtar, köken) çiftleri kaydedilir ve kaldırırken yalnızca onlar gider.
 *
 * PERFORMANS: yalnızca pencere açıldığında ve düğmeye basılınca; okuma 9
 * `reg query`.
 */

const ROOT = 'HKLM\\SOFTWARE\\Policies';
const BROWSERS = ['Google\\Chrome', 'Microsoft\\Edge', 'BraveSoftware\\Brave'] as const;
const POLICIES = [
  'WindowManagementAllowedForUrls',
  'PopupsAllowedForUrls',
  'AutomaticFullscreenAllowedForUrls',
] as const;

const KEYS: string[] = BROWSERS.flatMap((browser) => POLICIES.map((policy) => `${ROOT}\\${browser}\\${policy}`));

export interface CustomerDisplayStatus {
  /** Yalnızca Windows; macOS'ta yapılandırma profili gerekir, bu ajan yazmaz. */
  supported: boolean;
  /** İzin verilecek POS kökeni; sunucuya ulaşılamadıysa null. */
  origin: string | null;
  /** Dokuz girdinin hepsi yerinde. */
  ready: boolean;
  /** Bu ajanın eklediği ve kaldırabileceği girdi var mı. */
  removable: boolean;
}

// ── Köken doğrulama ─────────────────────────────────────────────────────────

/** Kabul edilebilir kökeni döner ya da null. `apiUrl` ile aynı siteye ait olmalı. */
export function acceptPosOrigin(candidate: unknown, apiUrl?: string): string | null {
  let url: URL;
  try {
    url = new URL(String(candidate));
  } catch {
    return null;
  }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return null;
  }
  // Joker yasak: URL ayrıştırıcısı `*`'ı host adında bırakıyor ve Chrome onu
  // desen olarak okur. Yalnızca harf, rakam, nokta, tire.
  if (!/^[a-z0-9.-]+$/.test(url.hostname)) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) return null;
  if (apiUrl !== undefined) {
    let api: URL;
    try {
      api = new URL(apiUrl);
    } catch {
      return null;
    }
    if (!sameSite(url.hostname, api.hostname)) return null;
  }
  return url.origin;
}

function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = -1, b = -1] = parts;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

const isIp = (host: string): boolean => /^[\d.]+$/.test(host);

/** Aynı host ya da aynı üst alan adı (api.x.com ↔ pos.x.com); `com.tr` gibi ortak sonek yetmez. */
function sameSite(a: string, b: string): boolean {
  if (a === b) return true;
  if (isIp(a) || isIp(b)) return false;
  const parent = (host: string): string | null => {
    const labels = host.split('.');
    return labels.length >= 3 ? labels.slice(1).join('.') : null;
  };
  const pa = parent(a);
  const pb = parent(b);
  return (pa !== null && (pa === pb || pa === b)) || (pb !== null && pb === a);
}

// ── Sunucudan köken ─────────────────────────────────────────────────────────

let cachedOrigin: string | null = null;

/** `/agent/info` → doğrulanmış köken. Süreç ömrü boyunca önbellekte. */
export async function fetchPosOrigin(apiBaseUrl: string, token: string): Promise<string | null> {
  if (cachedOrigin) return cachedOrigin;
  try {
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/v1/agent/info`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn('agent info failed', { status: res.status });
      return null;
    }
    const body = (await res.json()) as { data?: { posOrigin?: unknown } };
    const origin = acceptPosOrigin(body?.data?.posOrigin, apiBaseUrl);
    if (!origin) log.warn('agent info: rejected pos origin', { value: String(body?.data?.posOrigin).slice(0, 120) });
    cachedOrigin = origin;
    return origin;
  } catch (err) {
    log.warn('agent info unreachable', err);
    return null;
  }
}

// ── Kayıt defteri: okuma (yetki istemez) ─────────────────────────────────────

async function readList(key: string): Promise<string[]> {
  try {
    const { stdout } = await run('reg', ['query', key, '/reg:64'], { windowsHide: true, timeout: 10_000 });
    const values: { n: number; v: string }[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s{4}(\d+)\s+REG_SZ\s+(.*)$/.exec(line);
      if (match?.[1] && match[2] !== undefined) values.push({ n: Number(match[1]), v: match[2].trim() });
    }
    return values.sort((x, y) => x.n - y.n).map((row) => row.v);
  } catch {
    return []; // Anahtar yok.
  }
}

async function keysMissing(origin: string): Promise<string[]> {
  const lists = await Promise.all(KEYS.map((key) => readList(key)));
  return KEYS.filter((_key, index) => !(lists[index] ?? []).includes(origin));
}

// ── Bizim eklediklerimiz ─────────────────────────────────────────────────────

function ledgerFile(dataDir: string): string {
  return path.join(dataDir, 'customer-display.json');
}

function readLedger(dataDir: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerFile(dataDir), 'utf8')) as { entries?: unknown };
    return Array.isArray(parsed.entries)
      ? parsed.entries.filter((entry): entry is string => {
          if (typeof entry !== 'string') return false;
          const [key, origin] = entry.split('|');
          return Boolean(key && KEYS.includes(key) && acceptPosOrigin(origin) !== null);
        })
      : [];
  } catch {
    return [];
  }
}

function writeLedger(dataDir: string, entries: string[]): void {
  fs.writeFileSync(ledgerFile(dataDir), `${JSON.stringify({ entries }, null, 2)}\n`);
}

// ── Kayıt defteri: yazma (bir kez UAC) ───────────────────────────────────────

/** PowerShell tek tırnaklı dize. Değerler zaten doğrulanmış; yine de kaçışlanır. */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Yetkili süreçte çalışacak betik: verilen anahtarlara kökeni ekler ya da
 * listeden çıkarır; liste 1..n olarak yeniden numaralanır (Chrome liste
 * politikalarını sıralı numaralı değerlerden okur). Dışa aktarılır ki test
 * edilebilsin.
 */
export function buildPolicyScript(action: 'add' | 'remove', origin: string, keys: string[]): string {
  if (acceptPosOrigin(origin) === null) throw new Error('Geçersiz köken');
  const safeKeys = keys.filter((key) => KEYS.includes(key));
  const psKeys = safeKeys.map((key) => psQuote(key.replace(/^HKLM\\/, 'HKLM:\\'))).join(',');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$origin = ${psQuote(origin)}`,
    `$action = ${psQuote(action)}`,
    `foreach ($k in @(${psKeys})) {`,
    '  $current = @()',
    '  if (Test-Path $k) {',
    '    $item = Get-ItemProperty -Path $k',
    "    $current = @($item.PSObject.Properties | Where-Object { $_.Name -match '^\\d+$' } | Sort-Object { [int]$_.Name } | ForEach-Object { [string]$_.Value })",
    '  }',
    "  if ($action -eq 'add') {",
    '    if ($current -contains $origin) { continue }',
    '    $next = @($current) + $origin',
    '  } else {',
    '    if (-not ($current -contains $origin)) { continue }',
    '    $next = @($current | Where-Object { $_ -ne $origin })',
    '  }',
    '  if (Test-Path $k) { Remove-Item -Path $k -Force }',
    '  if ($next.Count -gt 0) {',
    '    New-Item -Path $k -Force | Out-Null',
    '    for ($i = 0; $i -lt $next.Count; $i++) {',
    '      New-ItemProperty -Path $k -Name ([string]($i + 1)) -Value $next[$i] -PropertyType String -Force | Out-Null',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

const POWERSHELL = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const encode = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');

/** Betiği tek bir UAC onayıyla yönetici olarak çalıştırır. İptal → hata. */
async function runElevated(script: string): Promise<void> {
  const outer = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath ${psQuote(POWERSHELL)} -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
      `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',${psQuote(encode(script))}`,
    'exit $p.ExitCode',
  ].join('\n');
  try {
    await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(outer)], {
      windowsHide: true,
      timeout: 120_000,
    });
  } catch (err) {
    const text = err instanceof Error ? `${err.message} ${(err as { stderr?: string }).stderr ?? ''}` : String(err);
    if (/cancel|iptal|1223/i.test(text)) throw new Error('İzin verilmedi — Windows onayında “Hayır” seçildi.');
    log.warn('customer display policy write failed', { error: text.slice(0, 400) });
    throw new Error('İzinler yazılamadı. Bilgisayarda yönetici hesabıyla tekrar deneyin.');
  }
}

// ── Dışa açık işlemler ───────────────────────────────────────────────────────

export async function customerDisplayStatus(origin: string | null, dataDir: string): Promise<CustomerDisplayStatus> {
  if (process.platform !== 'win32') return { supported: false, origin, ready: false, removable: false };
  const removable = readLedger(dataDir).length > 0;
  if (!origin) return { supported: true, origin: null, ready: false, removable };
  const missing = await keysMissing(origin);
  return { supported: true, origin, ready: missing.length === 0, removable };
}

/** Eksik girdileri tek UAC onayıyla ekler; eklediklerini kaydeder. */
export async function grantCustomerDisplay(origin: string, dataDir: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Yalnızca Windows');
  const missing = await keysMissing(origin);
  if (missing.length === 0) return;
  await runElevated(buildPolicyScript('add', origin, missing));
  const stillMissing = new Set(await keysMissing(origin));
  const added = missing.filter((key) => !stillMissing.has(key));
  const ledger = new Set(readLedger(dataDir));
  added.forEach((key) => ledger.add(`${key}|${origin}`));
  writeLedger(dataDir, [...ledger]);
  log.info('customer display permissions granted', { origin, added: added.length });
  if (stillMissing.size > 0) throw new Error('İzinlerin bir kısmı yazılamadı. Tekrar deneyin.');
}

/** Yalnızca bu ajanın eklediklerini tek UAC onayıyla kaldırır. */
export async function revokeCustomerDisplay(dataDir: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const entries = readLedger(dataDir);
  if (entries.length === 0) return;
  const byOrigin = new Map<string, string[]>();
  for (const entry of entries) {
    const [key = '', origin = ''] = entry.split('|');
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), key]);
  }
  const script = [...byOrigin].map(([origin, keys]) => buildPolicyScript('remove', origin, keys)).join('\n');
  await runElevated(script);
  writeLedger(dataDir, []);
  log.info('customer display permissions removed', { entries: entries.length });
}
