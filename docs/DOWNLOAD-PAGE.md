# `ariadisyon.com/indir` — download page

Implemented in the marketing site (`ari-adisyon-backend/apps/web`). This file is the
contract between the two repositories.

## How a download resolves

```
visitor → GET /indir/windows            (site, version-free, stable forever)
        → GitHub API: releases/latest   (cached 5 min)
        → 302 → the newest .exe on GitHub's CDN
```

The site never stores or proxies the binary. It only answers *which file*, then hands
the browser to GitHub. One release feeds both the download button and
`electron-updater`, so the page can never advertise a build the updater does not know.

| Route | Purpose |
| --- | --- |
| `GET /indir/windows` | Newest `.exe`, as a 302. Also `/indir/win` |
| `GET /indir/macos` | Newest `.dmg`, as a 302. Also `/indir/mac` |
| `GET /indir/linux` | Newest `.AppImage`/`.deb`, when one is published |
| `GET /indir/latest.json` | Version, file names, sizes, SHA-512 |

`/indir/latest.json`:

```json
{
  "version": "0.1.0",
  "tag": "v0.1.0",
  "publishedAt": "2026-08-11T00:00:00Z",
  "downloads": [
    { "os": "windows", "url": "/indir/windows", "file": "…Setup.0.1.0.exe",
      "sizeBytes": 78000000, "size": "74 MB", "sha512": "…" }
  ]
}
```

The digest is **SHA-512, base64** — that is what electron-builder writes into
`latest.yml` and what the updater verifies. Publishing a second, separately computed
SHA-256 would be a number that can disagree with the one that matters.

## Which assets are offered

Selected by extension, newest release only:

| os | asset |
| --- | --- |
| `win` | `*.exe` (NSIS installer) |
| `mac` | `*.dmg` |

Deliberately hidden: `*.blockmap`, `latest*.yml`, and the macOS `*.zip`. All three are
`electron-updater` payloads — a café owner who downloads the zip gets an archive that
does nothing when double-clicked.

When a release carries several builds for one OS, the site prefers
`universal` > `x64` > `arm64` > `ia32`, so nobody is handed a 32-bit build by accident.

## Repository visibility

`AGENT_RELEASE_REPO` (`owner/repo`) tells the site where to look. Two cases:

- **Public repo** — the button redirects to the permanent asset URL. `electron-updater`
  works out of the box.
- **Private repo** — set `AGENT_RELEASE_TOKEN` (fine-grained, read-only `contents`). The
  site mints a short-lived signed URL per click, so the token stays on the server.
  **But the app's own auto-update does not have this option**: `electron-updater` would
  need the token shipped inside the installer, where anyone can read it. A private
  release repo therefore means no auto-update.

## Page

Detect the OS from the user agent, show that installer as the primary button, and keep
the other build visible (people download on a phone and install on the till). Always
print the version and the file size; the SHA-512 belongs on the setup page.

Three steps, plain Turkish:

1. **İndirin** — big button: *Windows için indir* / *Mac için indir*.
2. **Kurun** — çift tıklayın, kurulum bitince ajan sistem tepsisinde çalışır.
3. **Eşleştirin** — panelinizde **Yazıcı ajanı ekle**'ye basıp çıkan 6–8 haneli kodu
   ajana yazın (kod 15 dakika geçerli).

Then: "Yazıcılarınızı seçin ve **Test yazdır**'a basın. Türkçe harfler doğru çıkmıyorsa
kod sayfasını değiştirin."

## Failure modes, and what the site does

| Situation | Answer |
| --- | --- |
| No release published yet | Buttons hidden (a button whose only behaviour is a 404 reads as a broken product) |
| GitHub unreachable while rendering | Buttons stay, CMS version shown; a click gets `503` and "try again shortly" |
| OS has no asset in this release | That button hidden, the others stay |
| Unknown OS in the URL | `404` |

`503` rather than `404` during an outage is deliberate: `404` on the download page gets
it de-indexed.

## Notes

- Serve over HTTPS only; never proxy the binary through a redirect chain that strips the
  signature.
- If a build is unsigned, say so on the page and explain the SmartScreen/Gatekeeper
  prompt — better than a café owner assuming it is malware. Signed builds need no note.
- Minimum requirements: Windows 10 1809+ / macOS 11+.
