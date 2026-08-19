# Ari Adisyon Ajanı

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
| [src/main/okc/pclink.ts](src/main/okc/pclink.ts) | Hugin PC Link HTTPS client, certificate pinning |
| [src/main/okc/okc.ts](src/main/okc/okc.ts) | Fiscal sale flow, `206` recovery, durable pending document |
| [src/main/bridge/bridge-link.ts](src/main/bridge/bridge-link.ts) | `/bridge` socket, pairing, short-lived token refresh, sale dispatch |
| [src/renderer/](src/renderer/) | Turkish settings UI (rail nav: status · printers · ÖKC · logs) |

Internal documentation (environment and logging design, security notes, the backend
contract, the download page) lives in `docs/`, which is deliberately not published:
it is kept in the team's own copy of this checkout, not in the public repository.

## Printer setup

**Network (recommended).** Enter the printer's IP and port 9100. Zero drivers, most
reliable, survives OS updates. "Ağda yazıcı ara" sweeps the local /24 for open :9100.

**USB.** Install the printer in Windows/macOS as a normal printer first, then pick it
from the dropdown. The agent sends raw bytes to the OS queue; the vendor driver owns
the USB transport.

## Yazarkasa (ÖKC) — Hugin PC Link

The agent also drives a **cabled Hugin fiscal device** over its local REST API. No DLL,
no sidecar: the device runs an HTTPS server on `:4443` and the agent is the client.
(Hugin's *wireless* path — Cloud Link — inverts this and needs no agent at all; there
the backend is the server. See the backend's `drivers/hugin/README.md`.)

### Two pairings, two identities

The printer agent is a `Printer` row; the fiscal bridge is a `Terminal`. They run in
the same process but pair separately, and revoking one must not drop the other — so the
bridge key lives in its own `bridge.key` (safeStorage), never beside `device.token`.

Sales arrive over **socket.io `/bridge`**, not the printer's raw `/agent` socket. That
channel already solves what this needs — Redis-adapter fan-out across API instances,
room-scoped delivery, `ack`/`result` correlation and the timeout sweep that asks
`query-last` when a reply goes missing. Carrying one dependency in the agent was cheaper
than writing a second copy of that logic in the backend. The `/agent` protocol carries
**tickets only**; two channels claiming the same sale is how a customer gets charged twice.

Pair it under **Yazarkasa → Satış bağlantısı** with the code from the admin panel
(device → *Kurulum kodu*).

### Device setup

Set the device up under **Yazarkasa**: IP, port, optional label. Then:

| Step | Call |
| --- | --- |
| Health / open-document check | `GET /v1/status` |
| Start the document | `POST /v1/documents` → `documentId` |
| Finish it with items + payments | `PUT /v1/documents/{id}` → `receiptNo` (`ZZZZ_NNNN`) |

**The document is built by the backend, not here.** The agent carries it opaquely,
tagged `HUGIN_PCLINK_V1`; a tag it does not recognise is refused rather than guessed.
The same document also feeds the wireless path, and two builders would mean two fiscal
receipts that differ by a kuruş.

`UNKNOWN` is never reported over the bridge. The protocol carries APPROVED/DECLINED
only, because "I don't know" is already a state on the backend — silence. The intent
stays SENT, the sweep moves it to TIMEOUT and asks `query-last`, and to that question the
agent answers honestly with `null`. Reporting uncertainty as DECLINED would write off
money that may well have been taken.

Three behaviours are the whole point of this module:

- **`UNKNOWN` is a first-class result.** A lost response is not a decline — the card may
  have been charged. It is reported as `UNKNOWN` and recovery is the cashier's call.
- **`206` means the payment succeeded but the receipt did not close.** The fix is
  resending the *identical* finalize request; starting a new payment would charge the
  customer twice. The agent retries, then hands it to the operator.
- **The `documentId` is written to disk before finalizing.** If the agent crashes
  mid-sale, that id is the only thing that can close the document still open on the
  device. The **Yazarkasa** panel shows it and offers retry / cancel.

Addresses are restricted to private ranges, and the device's self-signed certificate is
**pinned on first sight** — a chain check can never pass against a self-signed cert, but
"is this the same device?" still can.

## Turkish characters

Thermal printers need the right code page. Default is **CP857** (`ESC t 13`); the UI
also offers ISO-8859-9 (`ESC t 47`), CP1254, CP850, CP437 — per printer. The test print
includes `ç ğ ı i ö ş ü Ç Ğ I İ Ö Ş Ü` so the café verifies during setup. If a glyph is
unmappable, text folds to an ASCII lookalike rather than printing `?`.

## Packaging

```bash
npm run pack               # unpacked production build, local smoke test
npm run dist:mac           # universal dmg, unsigned (no Developer ID cert yet)
npm run dist:win           # signed NSIS installer (needs OV/EV cert; run on Windows)
npm run dist:staging:win   # staging installer, no publish
npm run dist:staging:mac   # staging dmg, no publish
```

Every `dist:*` script bakes its environment into `dist/main/build-env.json` first, so an
installer always knows which backend it belongs to.

Releases are cut by CI ([.github/workflows/release.yml](.github/workflows/release.yml)) on a
`v*` tag: a Windows runner builds the NSIS installer and publishes it to GitHub
Releases, which is also the `electron-updater` feed; a macOS runner then attaches the
universal DMG to the same release.

**Windows ships unsigned for now.** SmartScreen shows "unknown publisher" on first run
— the download page has to say so. `win.verifyUpdateCodeSignature` is therefore `false`:
with nothing signed there is no publisher for the updater to match, and the default
would make every auto-update fail. Updates are still authenticated by TLS to GitHub and
the SHA-512 in `latest.yml`.

**macOS ships unsigned too**, and the config pins that on purpose: `mac.identity` is
`null` and `hardenedRuntime` is off. Signing with the *Apple Development* certificate we
happen to hold would be worse than not signing at all — a Development identity with no
notarization ticket makes macOS report the app as damaged and refuse to launch it, with
no way through. Ad-hoc signed, the café clears one "unidentified developer" dialog from
System Settings → Privacy & Security and the app runs.

The settings window reports all of this rather than hiding it: the update block shows the
running version, whether a check is in flight, whether one is downloading and at what
percent, and — on macOS — that updates do not apply here at all, with a button to the
download page. A check the operator asked for always changes what is on screen, because
a button that reports nothing teaches people not to press it.

The cost is that **macOS has no auto-update**: Squirrel.Mac verifies the signature of the
build it downloaded, so an unsigned app can never install its own update.
[src/main/updater.ts](src/main/updater.ts) skips the check on `darwin` rather than
re-downloading 180 MB six times a day to discard it, and CI does not publish a
`latest-mac.yml`. Mac users update by downloading the new DMG.

To sign later: add `CSC_LINK` / `CSC_KEY_PASSWORD` to the repository secrets and set
`win.verifyUpdateCodeSignature: true`; for macOS add a Developer ID to `mac.identity`
with `hardenedRuntime: true` and `notarize: true`, supply `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, drop `CSC_IDENTITY_AUTO_DISCOVERY=false`
from the macOS job, and remove the `darwin` guard in the updater.

## Security notes

- Device token is stored via Electron `safeStorage` (OS keychain). If the keychain is
  unavailable the token stays in memory only — it is never written in plaintext.
- Logs redact anything matching `token`/`code`/`secret`/`password` plus `Bearer` values,
  before they reach the file, stdout, or the copyable in-app viewer.
- Renderer runs sandboxed with context isolation, a strict CSP, and no navigation; the
  preload exposes a fixed, validated IPC surface.
- A `401`/`403` handshake or a `revoked` message clears the pairing and stops retrying.
- The fiscal device address is restricted to private ranges (validated in the IPC layer
  *and* in the client), and its certificate is pinned after the first connection.
