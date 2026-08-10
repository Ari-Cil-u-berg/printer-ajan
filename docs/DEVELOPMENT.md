# Geliştirme rehberi — ortamlar, loglar, git

Bu dosya *ne yaptığımızı* değil, **neden öyle yaptığımızı** anlatır. Amaç: aynı kararları
bir dahaki projede kendin verebilesin.

İçindekiler:

1. [Ortam katmanı (dev / staging / prod)](#1-ortam-katmanı)
2. [Log katmanı](#2-log-katmanı)
3. [Uygulama içi log görüntüleyici](#3-uygulama-içi-log-görüntüleyici)
4. [Git kurulumu](#4-git-kurulumu)
5. [Günlük iş akışı](#5-günlük-iş-akışı)
6. [Yapılacaklar / dikkat](#6-yapılacaklar--dikkat)

---

## 1. Ortam katmanı

### Problem

Öncesinde tek bir yer vardı:

```ts
// src/main/config-store.ts (eski)
const DEFAULTS: AgentConfig = {
  apiBaseUrl: process.env.ARI_API_URL ?? 'https://api.ariadisyon.com',
  wsUrl: process.env.ARI_WS_URL ?? 'wss://api.ariadisyon.com/agent',
  ...
};
```

Üç ayrı sorun:

1. **Ortam kavramı yok.** Sadece "URL değişkeni var mı" bilgisi var. Log seviyesi,
   auto-update, devtools gibi ortama bağlı diğer kararlar kodun içine dağılmış durumda
   (`if (!app.isPackaged) return;` gibi).
2. **Bu değerler `config.json`'a yazılıyordu.** `update()` tüm config'i diske yazar. Yani
   bir kez dev'de çalıştırınca `apiBaseUrl: "http://localhost:8787"` diske yazılıyor;
   sonra aynı makinede prod build açıldığında dosyadan bu değer okunup **prod uygulama
   localhost'a bağlanmaya çalışıyor**. Sessiz ve teşhisi zor bir hata.
3. **Aynı `userData` klasörü.** Dev testi, kafedeki canlı kurulumun eşleştirme token'ı,
   iş kuyruğu ve ayar dosyasıyla aynı dizini paylaşıyor.

### Çözüm: tek bir `env` modülü

[src/main/env.ts](../src/main/env.ts) tüm ortam kararlarının **tek kaynağı**. Üç preset:

```ts
const PRESETS: Record<AppEnv, Omit<EnvConfig, 'env'>> = {
  development: { apiBaseUrl: 'http://localhost:8787', logLevel: 'debug', autoUpdate: false, ... },
  staging:     { apiBaseUrl: 'https://staging-api.ariadisyon.com', logLevel: 'debug', autoUpdate: true, ... },
  production:  { apiBaseUrl: 'https://api.ariadisyon.com', logLevel: 'info', autoUpdate: true, ... },
};
```

**Neden preset tablosu, dağınık `if` değil?** Çünkü "staging'de ne oluyor?" sorusunun
cevabı tek ekranda görünüyor. Yeni bir ortama özel davranış eklemek = tabloya bir alan
eklemek; kodun 5 ayrı yerinde `if (env === ...)` aramak değil.

### Ortam nasıl belirleniyor — öncelik sırası

```
ARI_ENV  →  NODE_ENV  →  dist/main/build-env.json  →  packaged ? production : development
```

Her adımın bir varlık sebebi var:

| Kaynak | Ne zaman kullanılır | Neden |
| --- | --- | --- |
| `ARI_ENV` | Geliştirici / CI bilinçli olarak zorlar | En yüksek öncelik: hata ayıklarken her şeyi ezebilmelisin |
| `NODE_ENV` | Node ekosistem alışkanlığı | Başka araçlar zaten set ediyorsa uyum sağla |
| `build-env.json` | **Paketlenmiş installer** | Kafedeki bilgisayarda kimse environment variable set etmeyecek. Staging installer'ı kendi staging olduğunu bilmeli |
| `isPackaged` | Son çare | Paketlenmişse prod, değilse dev — makul varsayılan |

`build-env.json` dosyasını [scripts/write-build-env.mjs](../scripts/write-build-env.mjs)
paketleme sırasında yazar:

```jsonc
// dist/main/build-env.json
{ "env": "staging", "builtAt": "2026-08-10T22:37:35.188Z" }
```

**Tuzak ve çözümü:** `dist/` klasörü kalıcı. Bir kez `build:prod` çalıştırıp sonra düz
`npm run build` yaparsan eski `build-env.json` orada kalır ve testler/dev çalıştırması
kendini prod sanır. Bu yüzden [scripts/copy-assets.mjs](../scripts/copy-assets.mjs)
başında dosyayı siliyoruz:

```js
// Düz `npm run build` ortam-nötrdür: önceki build:staging/build:prod'un
// bıraktığı ortamı sil, sonraki çalıştırmaya sızmasın.
await rm(path.join(root, 'dist/main/build-env.json'), { force: true });
```

Genel kural: **derleme çıktısı her zaman deterministik olmalı.** Bir önceki komutun izini
taşıyan `dist/` klasörü, "bende çalışıyor" hatalarının klasik kaynağıdır.

### `.env` dosyaları — sadece geliştirmede

```ts
function loadDotenvFiles(env: AppEnv): void {
  if (isPackaged()) return;   // ← kritik satır
  ...
}
```

**Neden paketlenmiş uygulama `.env` okumasın?** Çünkü okusaydı, kurulu programın yanına
`.env` bırakan herkes ajanı istediği sunucuya yönlendirebilirdi. Kafedeki bilgisayarda
çalışan bir uygulamada bu bir güvenlik açığıdır, kolaylık değil. Paketlenmiş uygulama
sadece gerçek environment variable'ları ve derlemeye gömülü ortamı dinler.

Öncelik (yüksekten düşüğe):

```
gerçek env var  >  .env.<env>.local  >  .env.local  >  .env.<env>  >  .env
```

Kural: **daha özel olan kazanır, gerçek ortam her şeyi ezer.** Uygulaması basit — bir
anahtar zaten `process.env` içinde varsa dokunma:

```js
if (process.env[k] === undefined) process.env[k] = v;
```

Dosyaların hangisi commit'lenir?

| Dosya | Git | Neden |
| --- | --- | --- |
| `.env.example` | ✅ commit | Dokümantasyon: hangi değişkenler var |
| `.env.development` / `.env.staging` / `.env.production` | ✅ commit | Gizli değil, takımın ortak varsayılanları. Yeni gelen `npm run dev` yazınca çalışsın |
| `.env`, `.env.local`, `.env.*.local` | ❌ ignore | Kişisel / gizli. `.gitignore`'da |

Bu ayrım önemli: "tüm `.env*` dosyalarını ignore et" yaygın bir tavsiye ama fazla kaba.
Gizli olmayan ortak varsayılanları commit'lersen, yeni geliştirici kurulum yapmadan
çalıştırabilir; gizli olanları ayrı `*.local` uzantısına iterek net bir sınır çizersin.

### Endpoint'ler artık diske yazılmıyor

```ts
// src/main/config-store.ts
return {
  ...base,
  ...raw,
  apiBaseUrl: base.apiBaseUrl,   // dosyadan geleni bilinçli olarak ez
  wsUrl: base.wsUrl,
  printers: raw.printers ?? {},
};
```

**Neden `...raw` içindeki değeri ezmek doğru?** Çünkü bu değerler *kullanıcı ayarı*
değil, *dağıtım gerçeği*. Kullanıcı ayarları (yazıcı haritası, cihaz adı, autostart)
dosyada kalmalı; ortamın kim olduğu her açılışta yeniden hesaplanmalı. Kalıcı hale
getirirsen yukarıdaki "prod build localhost'a bağlanıyor" hatasını üretirsin.

Genel prensip: **türetilebilen şeyi saklama.** Kalıcı hale getirdiğin her değer, ileride
yanlış olabilecek bir kopyadır.

### Ortam başına `userData` izolasyonu

```ts
// src/main/index.ts — app.whenReady()'den ÖNCE çalışmalı
if (env.env !== 'production') {
  app.setPath('userData', `${app.getPath('userData')}-${env.env}`);
}
```

Bu üç satır şunları ayırır: `config.json`, `device.token`, iş kuyruğu, ack outbox.
Yani mock sunucuyla test yaparken kafenin canlı eşleştirmesini bozman **fiziksel olarak**
imkânsız hale gelir. Bonus: Electron'un tek-örnek kilidi (`requestSingleInstanceLock`)
`userData` yoluna bağlı olduğundan, dev ve prod aynı anda çalışabilir.

Zamanlama önemli: `setPath` `app.whenReady()`'den önce çağrılmalı, yoksa bazı yollar
zaten eski değerle çözülmüş olur. Bu yüzden modülün en üstünde, `main()` içinde değil.

### Görünürlük

Yanlış ortamda test etmek, klasik bir zaman kaybıdır. Bu yüzden ortam üç yerde görünür:

- Pencere başlığı: `Ari Adisyon Yazıcı Ajanı — STAGING`
- Header'da renkli rozet + "Durum" kartında `Ortam / sunucu` satırı
- Tray menüsünde `Ortam: staging` satırı

Hepsi prod'da gizli — kafedeki kullanıcının bu bilgiye ihtiyacı yok, geliştiricinin var.

---

## 2. Log katmanı

### Seviyeler

Öncesinde `info/warn/error` vardı ve hepsi her zaman yazılıyordu. Şimdi eşik ortamdan
geliyor:

```ts
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function write(level: LogLevel, args: unknown[]): void {
  const cfg = envConfig();
  if (ORDER[level] < ORDER[cfg.logLevel]) return;  // erken çık
  ...
}
```

**Neden sayısal sıra, string karşılaştırma değil?** `'debug' < 'info'` alfabetik olarak
doğru sonuç verir ama `'warn' < 'error'` vermez. Sayı tablosu niyeti açık yazar ve
yanlış anlaşılmaz.

Dev'de `debug`, prod'da `info`. Sebep: prod'da disk yazma maliyeti ve gürültü; dev'de
her şeyi görmek istersin.

### Redaction — kopyalanabilir loglarda gizli veri olmaz

Bu ajan bir eşleştirme kodunu kalıcı bir cihaz token'ına çeviriyor. Log dosyası destek
ekibine gönderilecek. Dolayısıyla redaction bir "iyi olurdu" değil, zorunluluk:

```ts
value
  .replace(/(token|code|authorization)"?\s*[:=]\s*"?(bearer\s+)?[\w.\-]+/gi, '$1=***')
  .replace(/\bbearer\s+[\w.\-]+/gi, 'Bearer ***');
```

İkinci `replace` testi yazarken ortaya çıktı: eski regex `authorization=Bearer abc123`
girdisinde sadece `Bearer` kelimesini yiyip **token'ı olduğu gibi bırakıyordu**. Test
yazmasaydık bu açık fark edilmezdi.

> Ders: güvenlik amaçlı bir dönüşüm yazdıysan, ona *kötü niyetli* girdi veren bir test
> yaz. "Çalışıyor mu" değil, "atlatılabiliyor mu" diye sor.

Nesnelerde anahtar bazlı redaction da var (`/token|code|secret|password/i`), yani
`{ token: 'x' }` → `{ token: '***' }`. İki katman: anahtar adına göre ve metin
desenine göre.

### Ring buffer + subscribe

```ts
const buffer: LogEntry[] = [];               // son 1000 satır
const listeners = new Set<(e: LogEntry) => void>();
```

- **Neden ring buffer?** Uygulama açıldıktan sonra pencereyi açan kullanıcı, o ana kadar
  olan biteni görebilsin. Sınırsız büyürse bellek sızıntısı olur; 1000 satır makul.
- **Neden `Set` ve `unsubscribe` dönen `subscribe`?** Dinleyiciyi kaldırmanın yolu yoksa,
  kapanan pencereler birikip sızıntı yapar. `subscribe` fonksiyonun kendisi temizleme
  fonksiyonunu döndürür — çağıran, kaldırma yolunu unutamaz.
- **Dinleyici hata fırlatırsa?** Yutulur:

  ```ts
  try { fn(entry); } catch { /* bozuk dinleyici loglamayı bozmamalı */ }
  ```

  Loglama altyapıdır. Altyapı, kendisini kullanan kodun hatası yüzünden çökmemeli. Aynı
  sebeple dosyaya yazma da `try/catch` içinde.

### Ortam başına ayrı dosya

```ts
return env === 'production' ? 'agent.log' : `agent-${env}.log`;
```

Bir dev oturumundaki debug gürültüsü, gerçek bir olayın kaydını 2 MB rotasyon sınırında
dosyadan dışarı itmesin diye.

---

## 3. Uygulama içi log görüntüleyici

### Neden gerekli

Kafedeki kullanıcı `~/Library/Logs/...` klasörüne gidip dosya bulamaz. "Kopyala"ya basıp
WhatsApp'tan gönderebilir. Destek süresi dakikalardan saniyelere iner.

### Ana süreçten pencereye akış — batching

```ts
// src/main/ipc.ts
return log.subscribe((entry) => {
  pending.push(entry);
  if (pending.length > 200) pending.splice(0, pending.length - 200);
  if (!timer) timer = setTimeout(flush, 150);
});
```

**Neden her satırı anında göndermiyoruz?** Bir yeniden bağlanma fırtınası veya
`soak 50` testi saniyede yüzlerce satır üretir. Her satır = bir IPC mesajı + bir DOM
işlemi. 150 ms'lik pencerede toplayıp tek mesaj göndermek, renderer'ı akıcı tutar.
Klasik "coalescing" tekniği: **olay sıklığını, insanın algılayabileceği hıza indir.**
İnsan 150 ms gecikmeyi fark etmez; 60 kez saniyede yapılan DOM güncellemesini fark eder.

### Renderer tarafı

- Yeni satırlar `appendChild` ile eklenir, tüm liste yeniden çizilmez. Filtre
  değiştiğinde tam yeniden çizim yapılır (`renderLogs`) — nadiren olan iş pahalı olabilir,
  sık olan iş ucuz olmalı.
- Otomatik kaydırma sadece kullanıcı zaten en alttaysa yapılır:

  ```ts
  function atBottom(view: HTMLElement): boolean {
    return view.scrollTop + view.clientHeight >= view.scrollHeight - 24;
  }
  ```

  Kullanıcı yukarı kaydırıp bir şey okuyorsa, yeni log onu aşağı fırlatmamalı. Küçük
  detay, ama "iyi yazılmış" hissini veren şey tam olarak bu.
- Metin her zaman `textContent` ile yazılır, `innerHTML` ile değil. Log içeriği sunucudan
  gelen veriyi taşıyabilir; `innerHTML` kullanmak XSS kapısıdır. Renderer'da sıkı bir CSP
  zaten var ama tek savunma katmanına güvenilmez.
- Kopyalama: önce `navigator.clipboard`, olmazsa gizli `textarea` + `execCommand('copy')`.
  Sebep: `file://` üzerinden yüklenen sayfalar async clipboard API'sini her zaman güvenli
  bağlam saymaz.

### "Ekranı temizle" dosyayı silmez

Buffer temizlenir, dosya kalır. Kullanıcı ekranı toparlayabilmeli ama denetim izini
yok edememeli.

---

## 4. Git kurulumu

Sırayla yapılanlar ve sebepleri.

### 4.1 Ayrı repo

```bash
cd ari-adisyon-ajan
git init -b main
```

`-b main`: varsayılan dal adını başta belirle, sonradan `git branch -m` ile düzeltme.

**Neden backend monorepo'suna değil, ayrı repo?**

- `electron-builder.yml` içindeki `publish` bloğu bir GitHub reposunu **auto-update
  feed'i** olarak kullanıyor. `electron-updater` o reponun Releases sayfasına bakar.
  Backend commit'leriyle karışık bir repoda sürüm etiketleri (`v*`) anlamını kaybeder.
- Sürüm döngüleri farklı: backend günde 5 kez deploy olabilir, masaüstü ajanı ayda bir
  installer çıkarır.
- Release workflow'u `v*` tag'ine bağlı. Ortak repoda her backend tag'i Windows + macOS
  imzalama işi tetikler.

### 4.2 `.gitignore` denetimi

Zaten vardı, `.env` kuralları netleştirildi:

```gitignore
node_modules/
dist/          # derleme çıktısı — kaynaktan üretilir
release/       # installer'lar — CI üretir
*.pfx          # kod imzalama sertifikaları
*.p12
.env           # kişisel/gizli
.env.local
.env.*.local
```

Kural: **üretilebilen veya gizli olan hiçbir şey repoda durmaz.** Ama tersi de geçerli —
üretilemeyen şey durmalı. Bu yüzden `assets/*.png` ve `build/icon.png` commit'li: CI
`gen-icons.mjs` çalıştırmıyor, ikonları repodan okuyor. Commit'lemeseydik release
derlemesi ikonsuz çıkardı. `package-lock.json` de commit'li, çünkü `npm ci` onsuz
çalışmaz ve tekrarlanabilir derleme için şart.

### 4.3 `.gitattributes`

```gitattributes
* text=auto eol=lf
*.ps1 text eol=crlf
*.png binary
package-lock.json linguist-generated=true -diff
```

- `text=auto eol=lf`: repoda her zaman LF. Windows ve macOS geliştiricileri birlikte
  çalışırken "tüm dosya değişmiş görünüyor" diff gürültüsünü engeller.
- `*.ps1 eol=crlf`: `raw-print.ps1` Windows'ta `powershell.exe` tarafından okunuyor;
  CRLF ile checkout etmek en güvenlisi.
- `*.png binary`: Git bunları metin sanıp satır sonu dönüşümü yapmasın, diff denemesin.
- `package-lock.json -diff`: 200 bin satırlık diff, kod incelemesini boğar.

### 4.4 Commit öncesi denetim

```bash
git add -A
git status --short          # ne izleniyor? node_modules/dist görünmemeli
git grep --cached -nEI '(BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})'
```

`--cached` = çalışma klasöründe değil, **stage'lenmiş içerikte** ara. Aradığın soru
"diskimde sır var mı" değil, "commit'e sır giriyor mu".

> Git'te bir sır bir kez commit'lendiyse, dosyayı silmek yetmez — geçmişte kalır.
> Push edildiyse sızmış kabul et ve **anahtarı iptal et**. Bu yüzden denetim commit'ten
> önce yapılır.

### 4.5 İlk commit

Tek bir "initial commit" atıldı: kod git'ten önce vardı, yapay olarak parçalara bölmek
gerçek bir geçmiş üretmez. Bundan sonra her mantıksal değişiklik ayrı commit olmalı.

Mesaj formatı — konu satırı ≤ 50 karakter, gövdede **neden**:

```
chore: initial commit — Electron print agent

Tray-only print agent for Windows and macOS: ...
```

Kod ne yaptığını zaten anlatır; commit mesajı niye yaptığını anlatmalı.

### 4.6 Remote + push (senin yapman gereken)

Bu oturumda GitHub kimlik doğrulaması yok, o yüzden push yapılmadı. Sen şunları çalıştır:

```bash
cd ari-adisyon-ajan

# 1. GitHub'a giriş (bir kez)
gh auth login

# 2. Repoyu oluştur ve push et — private olarak
gh repo create ari-adisyon-ajan --private --source=. --remote=origin --push

# gh kullanmak istemezsen: repoyu web'den aç, sonra
#   git remote add origin git@github.com:<owner>/ari-adisyon-ajan.git
#   git push -u origin main
```

`--private` bilinçli: ticari kod, `UNLICENSED` lisans, ve auto-update feed'i public repo
gerektirmiyor (`electron-updater` private repo ile de çalışır, ama o zaman indirme
linklerinin token'la sunulması gerekir — public release varlıkları daha basittir. Karar
senin).

**Push'tan hemen sonra düzeltilmesi gereken bir satır var:**

```yaml
# electron-builder.yml
publish:
  provider: github
  owner: ariadisyon          # ← gerçek GitHub org/kullanıcı adın ne ise o olmalı
  repo: ari-adisyon-ajan
```

Backend repon `Ari-Cil-u-berg/ari-adisyon` altında. `owner` yanlışsa auto-update
sessizce 404 alır — uygulama çalışır ama **hiçbir zaman güncellenmez**. Repoyu açtıktan
sonra bu iki satırı gerçek değerlerle güncelle.

### 4.7 CI zaten hazır

- [.github/workflows/ci.yml](../.github/workflows/ci.yml): her push/PR'da `npm ci`,
  `typecheck`, `test`.
- [.github/workflows/release.yml](../.github/workflows/release.yml): `v*` tag'inde
  Windows imzalı NSIS + macOS imzalı/notarize DMG üretip Releases'a yükler.

Release için gereken secret'lar (repo → Settings → Secrets and variables → Actions):
`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

İmzasız installer Windows'ta SmartScreen, macOS'ta Gatekeeper uyarısı verir — kafe
sahibi "bu program güvenli değil" ekranını görür ve kurmaz. Sertifika bütçesi kurulumun
parçası.

---

## 5. Günlük iş akışı

```bash
# Terminal 1 — sahte bulut sunucusu, eşleştirme kodu basar
npm run mock

# Terminal 2 — ajan (dev ortamı, mock'a bakar, debug logları açık)
npm run dev
```

Mock'un terminaline `bar`, `mutfak` veya `soak 50` yazarak fiş gönder.

| Komut | Ne yapar |
| --- | --- |
| `npm run dev` | development ortamında derle + çalıştır |
| `npm run dev:staging` | staging ortamı |
| `npm run start:prod` | prod endpoint'leriyle yerel çalıştırma (paketlenmemiş) |
| `npm run typecheck` | Derleme yapmadan tip denetimi |
| `npm test` | 32 test (ESC/POS, kuyruk, WS, loglama) |
| `npm run pack` | Paketlenmiş prod build, yerel duman testi |
| `npm run dist:win` / `dist:mac` | İmzalı installer |
| `npm run dist:staging:win` / `:mac` | Staging installer, publish etmez |

Commit öncesi refleks:

```bash
npm run typecheck && npm test
```

### Yeni bir ortam değişkeni nasıl eklenir

1. `EnvConfig` arayüzüne alanı ekle → [src/main/env.ts](../src/main/env.ts)
2. Üç preset'e de değerini yaz (derleyici zaten zorlar — `Record<AppEnv, ...>` sayesinde
   birini unutamazsın)
3. `build()` içinde `process.env.ARI_...` okumasını ekle (`bool()` / `level()`
   yardımcılarıyla)
4. `.env.example`'a yorumlu satır ekle
5. Kullanıcı görmesi gerekiyorsa `StatusSnapshot`'a ekle → preload → renderer

Adım 2'nin derleyici tarafından zorunlu tutulması bilinçli bir tasarım:
`Record<AppEnv, T>` kullanmak, "staging'i güncellemeyi unuttum" hatasını **derleme
zamanında** yakalar.

---

## 6. Yapılacaklar / dikkat

- [ ] `electron-builder.yml` → `publish.owner` gerçek GitHub hesabıyla güncellensin
      (yanlışsa auto-update sessizce çalışmaz).
- [ ] Staging gerçekten yayınlanacaksa ayrı bir publish kanalı gerekir; şu an
      `dist:staging:*` bilinçli olarak `-c.publish=null` ile publish etmiyor —
      staging build'in prod güncelleme feed'ini kirletmemesi için.
- [ ] `staging` preset'inde `autoUpdate: true`, ama `.env.staging` yerel çalıştırmada
      kapatıyor. Paketlenmiş staging `.env` okumadığı için preset geçerli olur — bu
      kasıtlı, ama şaşırtıcı olabilir. Aklında olsun.
- [ ] Sertifikalar alınana kadar `release` workflow'u imzasız çıktı üretir.
