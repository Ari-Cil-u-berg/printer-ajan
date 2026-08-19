#!/usr/bin/env bash
#
# Ari Adisyon Ajanı — sürüm yayınlama.
#
# NEDEN BİR BETİK: yayınlamak GERİ ALINAMAZ. Yayınlanan bir sürüm, kafelerdeki
# ajanların otomatik güncelleme akışına düşer ve saatler içinde kurulur. Elle
# çalıştırılan bir `electron-builder --publish always`, yanlış daldan, testler
# koşmadan ya da sürüm numarası artırılmadan çalıştırılabilir — üçü de sahada
# görünür ve üçü de geri alınamaz.
#
# Bu betiğin tamamı o üç hatayı imkânsız kılmak içindir: önce doğrula, sonra
# derle, en son yayınla.
#
# Kullanım:
#   npm run release                # ön kontroller + derleme + ONAY + yayın
#   npm run release -- --dry-run   # yayınlamaz, yalnızca derler
#   npm run release -- --yes       # onay sormaz (CI için)
#   npm run release -- --mac       # yalnızca macOS
#   npm run release -- --win       # yalnızca Windows

set -Eeuo pipefail

cd "$(dirname "$0")/.."

# ── görünüm ────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; RESET=''
fi

step()  { printf '\n%s▸ %s%s\n' "$BOLD$BLUE" "$*" "$RESET"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()   { printf '\n%s✗ %s%s\n\n' "$BOLD$RED" "$*" "$RESET" >&2; exit 1; }
note()  { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }

trap 'die "Beklenmeyen hata (satır $LINENO). Hiçbir şey yayınlanmadı."' ERR

# ── argümanlar ─────────────────────────────────────────────────────────────
DRY_RUN=0
ASSUME_YES=0
BUILD_MAC=0
BUILD_WIN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    --mac)     BUILD_MAC=1 ;;
    --win)     BUILD_WIN=1 ;;
    -h|--help)
      sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Bilinmeyen seçenek: $1" ;;
  esac
  shift
done

# Platform seçilmediyse ikisi de. Windows derlemesi macOS üzerinde NSIS ile
# üretilebiliyor; Linux'ta wine gerekir ve orada sessizce atlanır.
if [[ $BUILD_MAC -eq 0 && $BUILD_WIN -eq 0 ]]; then
  BUILD_WIN=1
  # `&&` tek satır DEĞİL: `set -e` altında koşul yanlış olduğunda satırın dönüş
  # değeri 1 olur ve betik sessizce çıkar. Yayın betiğinde "sessizce çıkmak",
  # hiçbir şey yapmadan başarılı görünmektir.
  if [[ "$(uname -s)" == "Darwin" ]]; then BUILD_MAC=1; fi
fi

if [[ $BUILD_MAC -eq 1 && "$(uname -s)" != "Darwin" ]]; then
  die "macOS derlemesi yalnızca macOS üzerinde yapılabilir (imzalama ve dmg araçları)."
fi

# ── jeton ──────────────────────────────────────────────────────────────────
#
# `.env` YALNIZCA GH_TOKEN için okunuyor, `source` edilmiyor. `source`, dosyadaki
# her satırı çalıştırır — `.env` bir kabuk betiği değil ve bir gün oraya
# tırnaksız bir değer ya da `$(...)` yazılırsa yayın betiği onu çalıştırır.
# Tek anahtarı ayrıştırmak, dosyanın veri olarak kalmasını sağlar.
#
# ÖNCELİK: gerçek ortam değişkeni > .env. Böylece CI'da dosya olmadan da çalışır
# ve yereldeki bir dosya, bilinçli olarak verilmiş bir jetonu ezemez.
if [[ -z "${GH_TOKEN:-}" && -f .env ]]; then
  GH_TOKEN="$(sed -n 's/^[[:space:]]*GH_TOKEN[[:space:]]*=[[:space:]]*//p' .env | head -n1 | tr -d '\r"'"'"' ')"
  if [[ -n "$GH_TOKEN" ]]; then
    export GH_TOKEN
    TOKEN_SOURCE=".env"
  fi
fi
TOKEN_SOURCE="${TOKEN_SOURCE:-ortam değişkeni}"

# electron-builder GITHUB_TOKEN'ı da okur. Ortamda geçersiz bir değer duruyorsa
# hangisini seçeceği belirsizleşir; tek kaynağa indiriyoruz.
unset GITHUB_TOKEN

VERSION="$(node -p "require('./package.json').version")"

printf '\n%sAri Adisyon Ajanı — sürüm %s%s\n' "$BOLD" "$VERSION" "$RESET"
if [[ $DRY_RUN -eq 1 ]]; then warn "KURU ÇALIŞTIRMA — hiçbir şey yayınlanmayacak"; fi

# ── 1. ön kontroller ───────────────────────────────────────────────────────
step "Ön kontroller"

command -v node >/dev/null || die "node bulunamadı."
ok "node $(node -v)"

if [[ $DRY_RUN -eq 0 ]]; then
  # `GITHUB_TOKEN` bilerek KABUL EDİLMİYOR: birçok ortamda (CI koşucuları, bazı
  # kabuk profilleri) başka bir amaç için doldurulmuş oluyor ve electron-builder
  # ikisini de okuduğu için yanlış jetonla yayın denemesi yapılabiliyor. Tek
  # kaynak `GH_TOKEN`.
  if [[ -z "${GH_TOKEN:-}" ]]; then
    printf '\n'
    warn "GH_TOKEN tanımlı değil — yayın yapılamaz."
    note "Fine-grained PAT (önerilen):"
    note "  https://github.com/settings/personal-access-tokens/new"
    note "  Resource owner: Ari-Cil-u-berg · Repository: printer-ajan"
    note "  Permissions → Contents: Read and write, Metadata: Read"
    note ""
    note "Classic PAT: https://github.com/settings/tokens/new · scope: repo"
    note ""
    note "Sonra:  export GH_TOKEN=ghp_...   ya da .env dosyasına GH_TOKEN=ghp_..."
    note "Yalnızca derlemek için:  npm run release -- --dry-run"
    die "GH_TOKEN gerekli."
  fi
  ok "GH_TOKEN tanımlı (kaynak: $TOKEN_SOURCE)"

  # Jetonun GERÇEKTEN çalıştığını 20 MB yükledikten sonra değil, şimdi öğren.
  if command -v curl >/dev/null; then
    HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer ${GH_TOKEN}" \
      -H 'Accept: application/vnd.github+json' \
      https://api.github.com/repos/Ari-Cil-u-berg/printer-ajan || echo 000)"
    case "$HTTP_CODE" in
      200) ok "Depoya erişim doğrulandı" ;;
      401) die "GH_TOKEN geçersiz (401). Süresi dolmuş ya da yanlış kopyalanmış olabilir." ;;
      403) die "GH_TOKEN yetkisiz (403). Contents: Read and write izni gerekli." ;;
      404) die "Depo görünmüyor (404). Fine-grained jetonda 'printer-ajan' seçili mi?" ;;
      *)   warn "Depo erişimi doğrulanamadı (HTTP $HTTP_CODE) — yine de denenecek" ;;
    esac
  fi
fi

# Git durumu: yayınlanan ikili dosyanın hangi koddan çıktığı sonradan
# sorulacak ve cevabın "bilmiyorum, çalışma kopyası kirliydi" olmaması gerekir.
if git rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  ok "dal: $BRANCH ($(git rev-parse --short HEAD))"
  if [[ -n "$(git status --porcelain)" ]]; then
    warn "Çalışma kopyası temiz değil — yayınlanan derleme commit'lenmemiş kod içerir"
    git status --short | sed 's/^/    /'
  fi
else
  warn "Git deposu değil — sürümün hangi koddan çıktığı izlenemeyecek"
fi

# Aynı sürümün ikinci kez yayınlanması: electron-updater için bu sessiz bir
# felakettir, çünkü kafedeki ajan sürüm numarasına bakar ve içerik değişse de
# güncelleme görmez.
if [[ $DRY_RUN -eq 0 ]] && command -v curl >/dev/null; then
  EXISTS="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    "https://api.github.com/repos/Ari-Cil-u-berg/printer-ajan/releases/tags/v${VERSION}" || echo 000)"
  if [[ "$EXISTS" == "200" ]]; then
    die "v${VERSION} zaten yayınlanmış. package.json'daki sürümü artırın."
  fi
  ok "v${VERSION} henüz yayınlanmamış"
fi

# ── 2. doğrulama ───────────────────────────────────────────────────────────
step "Tip denetimi"
npm run typecheck --silent
ok "tipler temiz"

step "Testler"
npm test --silent 2>&1 | tail -n 12
ok "testler geçti"

# ── 3. onay ────────────────────────────────────────────────────────────────
#
# ONAY DERLEMEDEN ÖNCE. Önceki sürüm önce derleyip sonra soruyordu; bu, her
# yayında aynı ikilileri İKİ KEZ üretmek demekti (bir kez göstermek, bir kez
# yayınlamak) ve altı dakika sürüyordu. electron-builder zaten yayınlamadan
# önce dosyaları yazıyor, yani gösterilecek şey yayınlanacak şeyle aynı.

PLATFORM_LABEL=""
if [[ $BUILD_MAC -eq 1 ]]; then PLATFORM_LABEL="macOS"; fi
if [[ $BUILD_WIN -eq 1 ]]; then PLATFORM_LABEL="${PLATFORM_LABEL:+$PLATFORM_LABEL + }Windows"; fi

if [[ $DRY_RUN -eq 0 && $ASSUME_YES -eq 0 ]]; then
  printf '\n%s%s─────────────────────────────────────────────%s\n' "$BOLD" "$YELLOW" "$RESET"
  printf '%sYAYINLANACAK — bu adım geri alınamaz.%s\n' "$BOLD" "$RESET"
  printf '  Sürüm   : %s\n' "$VERSION"
  printf '  Depo    : Ari-Cil-u-berg/printer-ajan\n'
  printf '  Platform: %s\n' "$PLATFORM_LABEL"
  printf '  Etki    : Kurulu ajanlar bu sürümü otomatik indirip kurar.\n'
  printf '%s%s─────────────────────────────────────────────%s\n' "$BOLD" "$YELLOW" "$RESET"
  # Sürüm numarasını YAZDIRIYORUZ, "e/h" sormuyoruz: refleksle basılan bir tuş,
  # yanlış sürümü yayınlamanın en kolay yolu.
  read -r -p "Devam etmek için sürüm numarasını yazın (${VERSION}): " CONFIRM
  if [[ "$CONFIRM" != "$VERSION" ]]; then die "Onaylanmadı. Hiçbir şey yayınlanmadı."; fi
fi

# ── 4. derleme (+ yayın) ───────────────────────────────────────────────────
rm -rf release
mkdir -p release

npm run build:prod --silent

BUILDER_ARGS=()
if [[ $BUILD_MAC -eq 1 ]]; then BUILDER_ARGS+=(--mac); fi
if [[ $BUILD_WIN -eq 1 ]]; then BUILDER_ARGS+=(--win); fi

# `--publish never` / `always`: `-c.publish=null` KULLANILMIYOR — electron-builder
# 25'te o değer `electron-publisher-null` diye var olmayan bir modül aramaya
# çalışıp derlemeyi düşürüyor. Bayrak, aynı işi yapılandırmayı bozmadan yapar.
if [[ $DRY_RUN -eq 1 ]]; then
  step "Derleme (yayınlanmayacak) — $PLATFORM_LABEL"
  npx --no-install electron-builder "${BUILDER_ARGS[@]}" --publish never
else
  step "Derleme ve yayın — $PLATFORM_LABEL"
  npx --no-install electron-builder "${BUILDER_ARGS[@]}" --publish always
fi

step "Üretilen dosyalar"
find release -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.exe' -o -name '*.yml' \) \
  -exec ls -lh {} \; | awk '{printf "  %-8s %s\n", $5, $NF}' | sed "s|$PWD/release/||"

if [[ $DRY_RUN -eq 1 ]]; then
  printf '\n%s✓ Kuru çalıştırma bitti. Dosyalar release/ altında, hiçbir şey yayınlanmadı.%s\n\n' "$GREEN" "$RESET"
  exit 0
fi

printf '\n%s✓ v%s yayınlandı.%s\n' "$BOLD$GREEN" "$VERSION" "$RESET"
note "https://github.com/Ari-Cil-u-berg/printer-ajan/releases/tag/v${VERSION}"
note "Sürüm taslak olarak açıldıysa GitHub'dan 'Publish release' ile yayına alın."
printf '\n'
