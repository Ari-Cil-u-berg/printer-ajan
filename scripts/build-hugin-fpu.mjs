// Builds the Hugin GMP-3 helper (native/hugin-fpu) into native/hugin-fpu/out,
// which electron-builder ships as resources/hugin-fpu on Windows.
//
// Three inputs, none of them committed:
//   1. Hugin's SDK DLLs — downloaded from a PINNED commit of github.com/huginsdk/fpu
//      and checked against SHA-256. A moved tag or a swapped file fails the build.
//   2. Hugin's "Certificates" folder — handed to us by Hugin support. The library
//      loads it from `Certificates/` next to the exe; without it pairing fails.
//      Path comes from HUGIN_CERTS_DIR.
//   3. The .NET SDK (`dotnet`) — compiles net462 on any OS via reference assemblies.
//
// Missing certificates or dotnet SKIP the helper with a warning, so a printer-only
// release is never blocked by T300 tooling. HUGIN_FPU=required turns that into a
// hard failure — use it for any release that must carry T300 support.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'native/hugin-fpu');
const vendor = path.join(project, 'vendor');
const out = path.join(project, 'out');
const required = process.env.HUGIN_FPU === 'required';

const SDK_COMMIT = '77b0795e9109a6350f095b59c0103004ac795ce2';
const SDK_BASE = `https://raw.githubusercontent.com/huginsdk/fpu/${SDK_COMMIT}/CSharp/NET_4.0_FRAMEWORK/etc`;
const SDK_FILES = {
  'Hugin.Common.dll': 'c774e2fd3664dc48e9d95370223a67aa97b91f0b8c8ae81c202b07681ca0e7c6',
  'Hugin.ExDevice.DiffieHellman.dll': 'ff5ae78d8b0775485ef196f69f2378524140f15aeb210a7aaceed6b769f8cbaa',
  'Hugin.GMPCommon.dll': '1cd1b7d1d364f7d259158853cf9371fda2ee7a5f18e546169df1123baa58b362',
  'Hugin.POS.CompactPrinter.FP300.dll': 'eab6f8be68fea10fc2c475e80019bb39f6117cf72e0fc1c93ee1590f6f2cffc9',
  'Newtonsoft.Json.dll': 'f1f01b3474b92d6e1c3d6adfae74ee0ea0eba6e9935565fe2317686d80a2e886',
  'System.Data.SQLite.dll': 'b796936007a9e14c3179d08c054b5d3697054cc6cb28a8596759fd30cd02fe7b',
};
// File names the library opens (strings inside Hugin.ExDevice.DiffieHellman.dll).
const CERT_FILES = ['Kurumsal-s1.crt', 'OKC-S1.cer', 'OKC-S1-SIL.crl'];

async function skip(reason) {
  if (required) {
    console.error(`[hugin-fpu] ${reason} — HUGIN_FPU=required, stopping.`);
    process.exit(1);
  }
  // `out/` is emptied, not left alone: a previous build's helper (or a test
  // build with placeholder certificates) must never ride along silently.
  // electron-builder then copies an empty folder and the app reports
  // "no T300 support in this version".
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  console.warn(`[hugin-fpu] ${reason} — helper SKIPPED; this build has no T300 (GMP-3) support.`);
  process.exit(0);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function fetchSdk() {
  await mkdir(vendor, { recursive: true });
  for (const [name, expected] of Object.entries(SDK_FILES)) {
    const target = path.join(vendor, name);
    try {
      if (sha256(await readFile(target)) === expected) continue;
    } catch {
      /* not downloaded yet */
    }
    const response = await fetch(`${SDK_BASE}/${name}`);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const actual = sha256(body);
    if (actual !== expected) throw new Error(`${name}: SHA-256 mismatch (${actual})`);
    await writeFile(target, body);
    console.log(`[hugin-fpu] fetched ${name}`);
  }
}

async function certificatesDir() {
  const dir = process.env.HUGIN_CERTS_DIR;
  if (!dir) return null;
  for (const name of CERT_FILES) {
    try {
      await stat(path.join(dir, name));
    } catch {
      throw new Error(`HUGIN_CERTS_DIR is missing ${name}`);
    }
  }
  return dir;
}

function hasDotnet() {
  try {
    execFileSync('dotnet', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const certs = await certificatesDir();
if (!certs) await skip('HUGIN_CERTS_DIR not set');
if (!hasDotnet()) await skip('dotnet SDK not found');

await fetchSdk();
execFileSync(
  'dotnet',
  ['build', path.join(project, 'AriHuginFpu.csproj'), '-c', 'Release', '-nologo', '-v', 'minimal'],
  { stdio: 'inherit' },
);

await rm(out, { recursive: true, force: true });
await cp(path.join(project, 'bin/Release'), out, {
  recursive: true,
  // Debug symbols and the Mac/Linux build host's leftovers stay behind.
  filter: (src) => !src.endsWith('.pdb'),
});
await mkdir(path.join(out, 'Certificates'), { recursive: true });
for (const name of CERT_FILES) {
  await cp(path.join(certs, name), path.join(out, 'Certificates', name));
}
console.log(`[hugin-fpu] ready: ${path.relative(root, out)}`);
