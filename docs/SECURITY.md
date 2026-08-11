# Güvenlik notları

Bu depo **public**. Yani kaynak kodun tamamı, mimarisi ve savunma sınırları herkese
açık. Bu bir sorun değil — sorun olsaydı zaten güvenlik kodun gizliliğine dayanıyor
demekti. Aşağısı, açık kaynak olmanın ne değiştirdiğini ve neyin nerede korunduğunu
yazar.

## 1. Bu depoda ne YOK

Public yapmadan önce tüm git geçmişi tarandı (`git log --all` üzerinden desen araması):
özel anahtar, API token'ı, parola veya sertifika **hiç commit'lenmedi**.

| Şey | Nerede | Repoda? |
| --- | --- | --- |
| Cihaz token'ı | Kullanıcının makinesinde, OS anahtarlığında (Electron `safeStorage`) | ❌ |
| Kod imzalama sertifikaları | GitHub Actions secrets (`WIN_CSC_LINK`, `MAC_CSC_LINK`, …) | ❌ (`*.pfx`, `*.p12` gitignore'da) |
| Backend sırları | Backend deposunda / sunucu ortamında | ❌ |
| `.env.development/staging/production` | Repoda **var** — ama içinde yalnızca herkesin zaten bileceği endpoint URL'leri var | ✅ kasıtlı |
| `.env`, `.env.local`, `.env.*.local` | Kişisel/gizli | ❌ gitignore'da |

Public repo'da bir sır bir kez commit'lenirse, dosyayı silmek yetmez: geçmişte kalır ve
bot'lar dakikalar içinde tarar. Kural — **sızmış say, anahtarı iptal et.**

## 2. Ajan neyi saklıyor, nasıl

| Veri | Yer | Koruma |
| --- | --- | --- |
| Cihaz token'ı | `device.token` (userData) | `safeStorage` ile şifreli, OS anahtarlığı destekli. Anahtarlık yoksa **diske hiç yazılmaz**, yalnızca bellekte tutulur |
| Yazıcı ayarları, cihaz adı | `config.json` | Düz metin — gizli veri değil |
| Bekleyen işler | `queue.json` | Fiş içeriği. 24 saat sonra `done` kayıtları düşer |
| Ack kuyruğu | `ack-outbox.json` | Yalnızca jobId + durum |
| Loglar | `agent.log` (2 MB'da döner) | Redaction'dan geçer (§3) |

Müşteri kişisel verisi (isim, telefon, adres, kart) ajanda **tutulmuyor** — fişte
yalnızca sipariş kalemleri, masa ve garson adı var, o da yalnızca yazdırılana kadar
kuyrukta kalıyor.

Eşleştirme kodu hiçbir zaman diske yazılmaz; yalnızca token saklanır ve token panelden
iptal edilebilir. `unpair` token'ı siler.

## 3. Loglarda sır olmaz

Her log satırı yazılmadan **önce** iki katmandan geçer:

- Anahtar adına göre: `token`, `code`, `secret`, `password` içeren alanlar `***`
- Metin desenine göre: `token=…`, `authorization=…`, `Bearer …` maskelenir

Log dosyası destek ekibine gönderilmek üzere tasarlandı; uygulama içindeki
görüntüleyicide "Kopyala" düğmesi var. Bu yüzden redaction bir tercih değil zorunluluk.
[tests/logger.test.mjs](../tests/logger.test.mjs) bunu düşman girdiyle test eder — nitekim
o test, `Bearer` token'larının eski regex'ten sızdığı gerçek bir açığı ortaya çıkardı.

## 4. Güven sınırları

### Renderer (ayarlar penceresi)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:`
- `will-navigate` engelli; `setWindowOpenHandler` yalnızca `https://` açar — `file:`,
  `smb:` veya kayıtlı özel şemalar OS'a iletilmez
- Preload sabit bir API yüzeyi verir; ham `ipcRenderer` sızdırılmaz
- IPC girdileri doğrulanır: istasyon adı beyaz listede, IP `^[\w.\-]+$`, port 1–65535,
  yazıcı adı ≤200 karakter ve kontrol karakteri içeremez

### Gateway → ajan (WebSocket)

Gateway güvenilir, ama "güvenilir" ≠ "hata yapmaz". Gelen her iş doğrulanır:

| Sınır | Değer | Neden |
| --- | --- | --- |
| WS çerçeve boyutu | 2 MB (`maxPayload`) | `ws` varsayılanı 100 MB; kendi doğrulamamız çalışmadan bellek tüketilebilirdi |
| `jobId` | 1–128 karakter | 24 saat `done` listesinde saklanıyor, her açılışta okunuyor |
| `escpos` (base64) | ≤1 MB | Kuyruk dosyası diske yazılıyor; şişik payload diski doldurur |
| Kalem sayısı | ≤200 | — |
| Metin alanları | ≤500 karakter | — |
| `copies` | Sayı olmalı; motor 1–5 arası kırpar | — |

Doğrulamayı geçemeyen iş kuyruğa **hiç girmez**, tek satır log bırakır.
[tests/security.test.mjs](../tests/security.test.mjs) sınırların her birini test eder.

### Ortam → ajan

Ajanın bir cihaz token'ı var ve kafenin tüm siparişlerini görüyor. Bir saldırgan
(kısayolu değiştiren, login script'i olan, aynı kullanıcı altında çalışan zararlı)
ortam değişkeni set edebilseydi, tilli kendi sunucusuna yönlendirebilirdi.

Bu yüzden **production'da endpoint override yok sayılır.** İstisna, gürültülü şekilde
loglanan `ARI_ALLOW_ENDPOINT_OVERRIDE=1`. Ayrıca development dışında `http://` / `ws://`
reddedilir — token'ı düz metin taşımaktansa preset'e dönülür.

`.env` dosyaları yalnızca paketlenmemiş çalıştırmada okunur; kurulu programın yanına
`.env` bırakmak hiçbir şeyi değiştirmez.

### Ajan → yerel ağ

- Ağ yazıcısı: yalnızca kullanıcının girdiği IP:port'a bağlanır
- "Ağda yazıcı ara": yalnızca makinenin kendi /24'ünü tarar, yalnızca kullanıcı
  tetiklerse
- USB yazıcı: `execFile` ile **argv dizisi** — kabuk yok, dolayısıyla enjeksiyon yok.
  Windows'ta `powershell.exe -File raw-print.ps1` parametre olarak alır

### Ajan → backend (istek hacmi)

Bir kafe zincirinde binlerce ajan olacak. Backend'i kendi istemcimizle boğmamak için:

| Davranış | Sınır |
| --- | --- |
| WS yeniden bağlanma | Üstel backoff + jitter, tavan 30 sn. Jitter, gateway yeniden başlayınca sürü etkisini kırar |
| 401/403 | Yeniden denemeyi **tamamen durdurur** — iptal edilmiş cihaz sonsuza kadar zorlamaz |
| Heartbeat | 5 dakikada bir, hatası yutulur |
| WS ping | 25 sn; 10 sn içinde pong yoksa soket öldürülür |
| Yazdırma yeniden denemesi | Yereldir, backend'e trafik üretmez; 20 denemede durur |
| Eşleştirme | Kullanıcı tetikler, istek sırasında düğme kilitli |

Backend tarafında karşılığı zaten var: Redis destekli global throttler, cihaz başına
sayan `DeviceAwareThrottlerGuard`, eşleştirme için IP başına 10/dk (`PAIRING_THROTTLE`).

## 5. Sürüm bütünlüğü

`electron-updater` GitHub Releases'i besleme olarak kullanır ve indirdiği paketin
SHA-512'sini `latest.yml`'deki değerle doğrular. Repo public olduğu için besleme
herkese açık; **yazma** yetkisi yalnızca depoya push edebilenlerde.

⚠️ **Kod imzalama henüz yok.** İmzasız installer'da:

- Windows SmartScreen ve macOS Gatekeeper uyarı verir — kafe sahibi "bu program güvenli
  değil" ekranını görür
- `electron-updater`, Windows'ta yayıncı adı doğrulamasını yapamaz

Sertifikalar (`WIN_CSC_LINK`, `MAC_CSC_LINK` + Apple notarization) kurulunca ikisi de
çözülür. O zamana kadar indirme sayfasında bu uyarının açıklanması gerekir.

## 6. Açık bulursanız

Public issue açmayın. `destek@ariadisyon.com` adresine yazın; etkilenen sürüm ve
yeniden üretme adımlarını ekleyin.

## 7. Açık kalan işler

- [ ] Kod imzalama sertifikaları (Windows OV/EV + Apple Developer ID)
- [ ] Backend'de ajanın beklediği uçlar (`/agent/pair`, `/agent/heartbeat`, WS `/agent`)
      henüz yok — yazılırken mevcut `printing/device` ucundaki korumaların aynısı
      gerekir: `@Public()` + kendi throttle'ı, argon2 ile doğrulanan cihaz anahtarı,
      cihaz başına sayan tracker
- [ ] WS gateway'de bağlantı başına eşzamanlılık ve iş gönderim hızı sınırı
