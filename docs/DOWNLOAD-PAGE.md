# `ariadisyon.com/indir` — download page

## Endpoint

`GET /agent/latest?os=win|mac` →

```json
{ "version": "0.1.0", "url": "https://github.com/ariadisyon/ari-adisyon-ajan/releases/download/v0.1.0/…", "sha256": "…" }
```

Source it from the GitHub Release assets for the newest `v*` tag (cache ~5 min):

| os | asset |
| --- | --- |
| `win` | `Ari-Adisyon-Yazici-Ajani-Setup-<version>.exe` |
| `mac` | `Ari-Adisyon-Yazici-Ajani-<version>-universal.dmg` |

`sha256` comes from the release's `latest.yml` / `latest-mac.yml`, which
`electron-updater` also consumes as the update feed — one source of truth for both the
download button and auto-update.

## Page

Detect the OS from the user agent, show that installer as the primary button, and keep
the other build behind a secondary "Diğer sürümler" link (people download on a phone and
install on the till). Always print the version and the SHA-256.

Three steps, plain Turkish:

1. **İndirin** — big button: *Windows için indir* / *Mac için indir*.
2. **Kurun** — çift tıklayın, kurulum bitince ajan sistem tepsisinde çalışır.
3. **Eşleştirin** — panelinizde **Yazıcı ajanı ekle**'ye basıp çıkan 6–8 haneli kodu
   ajana yazın (kod 15 dakika geçerli).

Then: "Yazıcılarınızı seçin ve **Test yazdır**'a basın. Türkçe harfler doğru çıkmıyorsa
kod sayfasını değiştirin."

## Notes

- Serve over HTTPS only; never proxy the binary through a redirect chain that strips the
  signature.
- If a build is unsigned, say so on the page and explain the SmartScreen/Gatekeeper
  prompt — better than a café owner assuming it is malware. Signed builds need no note.
- Minimum requirements: Windows 10 1809+ / macOS 11+.
