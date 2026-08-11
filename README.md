# Ari Adisyon Yazıcı Ajanı

Cross-platform (Windows + macOS) print agent. Runs in the system tray on the café till,
holds an outbound WSS connection to the cloud POS, and prints bar/kitchen tickets on
local thermal printers.

- **No inbound ports.** The agent dials out; nothing listens on the café PC.
- **No native modules.** Network printers over raw TCP:9100; USB printers via the OS
  print queue (`lp -o raw` on macOS, winspool `RAW` datatype on Windows).
- **No lost tickets.** Jobs are persisted before printing, deduped by `jobId`, retried
  with backoff, and acked only after the printer accepts them.

## Quick start (development)

```bash
npm install
node scripts/gen-icons.mjs          # once — writes assets/ and build/icon.png
npm run build
npm test                            # ESC/POS, queue, pairing, WS, reconnect, logging

# terminal 1 — mock cloud gateway; prints a pairing code
npm run mock

# terminal 2 — the agent in development (already points at the mock)
npm run dev
```

Pair with the code the mock prints, map a printer, then type `bar`, `mutfak` or
`soak 50` in the mock's terminal to dispatch tickets.

## Environments

Three environments, resolved at startup by [src/main/env.ts](src/main/env.ts):

| | `development` | `staging` | `production` |
| --- | --- | --- | --- |
| API / WS | `localhost:8787` | `staging-api.ariadisyon.com` | `api.ariadisyon.com` |
| Log level | `debug` | `debug` | `info` |
| Auto-update | off | on | on |
| userData | `…-development` | `…-staging` | default |
| Window title | `— DEVELOPMENT` badge | `— STAGING` badge | clean |

Resolution order: `ARI_ENV` → `NODE_ENV` → `dist/main/build-env.json` (baked at package
time by `scripts/write-build-env.mjs`) → packaged ? `production` : `development`.

Dev and staging get their own `userData` directory, so testing against a mock gateway can
never touch a café's live pairing token, config or job queue.

```bash
npm run dev            # development
npm run dev:staging    # staging
npm run start:prod     # production endpoints, local (unpackaged) run
```

Overrides come from environment variables, or from `.env` files **in dev runs only** — a
packaged installer never reads a `.env` next to itself. Precedence: real env vars >
`.env.<env>.local` > `.env.local` > `.env.<env>` > `.env`.

| Variable | Meaning |
| --- | --- |
| `ARI_ENV` | `development` \| `staging` \| `production` |
| `ARI_API_URL` / `ARI_WS_URL` | Gateway endpoints (override the preset) |
| `ARI_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `ARI_LOG_CONSOLE` | Mirror log lines to stdout |
| `ARI_AUTO_UPDATE` | Enable the electron-updater feed |
| `ARI_DEVTOOLS` | Open devtools with the settings window |

`.env.development` / `.env.staging` / `.env.production` are committed (non-secret
defaults). `.env`, `.env.local` and `.env.*.local` are gitignored — see
[.env.example](.env.example).

Endpoints are never persisted to `config.json`: they are re-read from the environment on
every start, so a config file written in dev can't point a prod build at localhost.

## Logs

Log lines go to three places at once: the log file, stdout (dev), and a 1000-line ring
buffer that the settings window streams live under **4. Günlükler**.

- Filter by level and free text, follow the tail, **Kopyala** to hand a café's log to
  support, **Dosyayı aç** / **Klasörü aç** for the file itself.
- File: `agent.log` in prod, `agent-<env>.log` otherwise, in the Electron `logs` path
  (`~/Library/Logs/…` on macOS, `%APPDATA%\…\logs` on Windows). Rotates at 2 MB to `.1`.
- Everything is redacted before it is buffered or written — `token`/`code`/`secret`/
  `password` keys and `Bearer` values never reach the file the user can copy out.
- `uncaughtException` and `unhandledRejection` are logged at `error`.
- "Ekranı temizle" clears the in-app buffer only; the file stays as the audit trail.

## Layout

| Path | Role |
| --- | --- |
| [src/main/index.ts](src/main/index.ts) | Tray, settings window, app lifecycle |
| [src/main/agent.ts](src/main/agent.ts) | Wires config + queue + engine + connection |
| [src/main/connection.ts](src/main/connection.ts) | WSS, reconnect/backoff, heartbeat, durable ack outbox |
| [src/main/pairing.ts](src/main/pairing.ts) | Pairing code → durable device token |
| [src/main/queue.ts](src/main/queue.ts) | Durable per-station FIFO queue, retry, idempotency |
| [src/main/print/escpos.ts](src/main/print/escpos.ts) | Ticket rendering, code pages, Turkish encoding |
| [src/main/print/network-driver.ts](src/main/print/network-driver.ts) | Raw TCP:9100 |
| [src/main/print/spooler-driver.ts](src/main/print/spooler-driver.ts) | `lp -o raw` / winspool RAW |
| [src/main/config-store.ts](src/main/config-store.ts) | Config + `safeStorage`-encrypted device token |
| [src/main/env.ts](src/main/env.ts) | Environment resolution, presets, `.env` loading |
| [src/main/logger.ts](src/main/logger.ts) | Leveled logging, redaction, rotation, in-app buffer |
| [src/renderer/](src/renderer/) | Turkish settings UI (pair → printers → status) |

Internal documentation (environment and logging design, security notes, the backend
contract, the download page) lives in `docs/`, which is deliberately not published:
it is kept in the team's own copy of this checkout, not in the public repository.

## Printer setup

**Network (recommended).** Enter the printer's IP and port 9100. Zero drivers, most
reliable, survives OS updates. "Ağda yazıcı ara" sweeps the local /24 for open :9100.

**USB.** Install the printer in Windows/macOS as a normal printer first, then pick it
from the dropdown. The agent sends raw bytes to the OS queue; the vendor driver owns
the USB transport.

## Turkish characters

Thermal printers need the right code page. Default is **CP857** (`ESC t 13`); the UI
also offers ISO-8859-9 (`ESC t 47`), CP1254, CP850, CP437 — per printer. The test print
includes `ç ğ ı i ö ş ü Ç Ğ I İ Ö Ş Ü` so the café verifies during setup. If a glyph is
unmappable, text folds to an ASCII lookalike rather than printing `?`.

## Packaging

```bash
npm run pack               # unpacked production build, local smoke test
npm run dist:mac           # signed + notarized dmg (needs Developer ID certs)
npm run dist:win           # signed NSIS installer (needs OV/EV cert; run on Windows)
npm run dist:staging:win   # staging installer, no publish
npm run dist:staging:mac   # staging dmg, no publish
```

Every `dist:*` script bakes its environment into `dist/main/build-env.json` first, so an
installer always knows which backend it belongs to.

Releases are cut by CI ([.github/workflows/release.yml](.github/workflows/release.yml)) on a
`v*` tag: a Windows runner signs the NSIS installer, a macOS runner signs and notarizes
the DMG, both publish to GitHub Releases, which is also the `electron-updater` feed.

Required secrets: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `MAC_CSC_LINK`,
`MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
Unsigned installers trigger SmartScreen/Gatekeeper warnings — budget for the certs.

## Security notes

- Device token is stored via Electron `safeStorage` (OS keychain). If the keychain is
  unavailable the token stays in memory only — it is never written in plaintext.
- Logs redact anything matching `token`/`code`/`secret`/`password` plus `Bearer` values,
  before they reach the file, stdout, or the copyable in-app viewer.
- Renderer runs sandboxed with context isolation, a strict CSP, and no navigation; the
  preload exposes a fixed, validated IPC surface.
- A `401`/`403` handshake or a `revoked` message clears the pairing and stops retrying.
