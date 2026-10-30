# Hugin T300 — GMP-3 yardımcı programı

T300 yalnızca Hugin'in **GMP-3 (FPU)** protokolüyle konuşuyor; PC Link / Cloud
Link REST arayüzü yok. Protokol kapalı .NET kütüphanelerinde ve Node/Electron
için kütüphane yok. Bu program ajanın T300'e açılan kapısı:

```
ajan (Electron) ──stdin/stdout, satır başına JSON──► AriHuginFpu.exe ──TCP 4444──► T300
```

- Para yolunun bütün kararları ajanda: `src/main/okc/okc-gmp3.ts` (testler
  `tests/gmp3.test.mjs`). Bu program yalnızca **izin listesindeki** kütüphane
  çağrılarını yapar (`Program.cs` → `Dispatch`); servis, programlama ve mali
  bellek komutları bilerek yok.
- Cevap türleri: `usage` / `not_connected` = cihaza hiçbir şey gitmedi (güvenle
  ret); `transport` = gitti, cevap gelmedi (ajan "bilmiyorum" der).
- Yalnız Windows. Mac'te ajan "T300 yalnız Windows'ta çalışır" der.

## Kaynaklar

- SDK ve wiki: <https://github.com/huginsdk/fpu> — sabit commit
  `77b0795e9109a6350f095b59c0103004ac795ce2`, wiki → "Teknik Döküman".
- Hugin entegrasyon ekibinin teknik notları: `PrintJSONDocumentDeptOnly`
  belgeyi kendisi başlatır (`PrintDocumentHeader` gerekmez); T300 ethernetle ağa
  bağlanır ve aldığı IP'den konuşulur.

## Derleme

```bash
HUGIN_CERTS_DIR=/yol/Certificates node scripts/build-hugin-fpu.mjs
```

- Hugin DLL'leri sabit commit'ten indirilir ve SHA-256 ile doğrulanır
  (`vendor/`, git dışı).
- Sertifika klasörü (`Kurumsal-s1.crt`, `OKC-S1.cer`, `OKC-S1-SIL.crl`) Hugin
  desteğinden gelir, **depoya girmez** (depo public). Kütüphane onu exe'nin
  yanındaki `Certificates/`'ten göreli yolla açar.
- `dotnet` SDK gerekir (net462 her işletim sisteminde derlenir).
- Çıktı `out/` → electron-builder `resources/hugin-fpu` olarak paketler.

**Sertifika yoksa** betik `out/`'u boşaltır, uyarı basar ve paket T300'süz
çıkar — yazıcı yayınları T300 araçlarına takılmasın. T300 taşıması gereken
yayında:

```bash
HUGIN_FPU=required HUGIN_CERTS_DIR=… npm run release -- --win
```

GitHub Actions'tan yayın alınacaksa Windows işine sertifikaları bir sırdan
`HUGIN_CERTS_DIR`'e açan bir adım eklenmeli (henüz yok).

## Cihazda doğrulanacaklar (kit gelince)

Belgeden okunup kodlandı ama gerçek T300'de ölçülmedi:

1. `PrintJSONDocumentDeptOnly` başlıksız belge açıyor mu (Hugin "evet" dedi;
   wiki "SELLING durumunda olmalı" diyor).
2. Kısmın `KDVGrupID`'si `GetVATRate` indeksiyle mi eşleşiyor (0 mı 1 mi
   tabanlı)? Ajan → Yazarkasa → Tanılama → "Kısım / KDV" satırı cihazın kendi
   menüsüyle karşılaştırılmalı. **Fişin KDV doğruluğu buna bağlı.**
3. `GetVATRate` oran metni (`10` / `10,00` / `1000`?).
4. Satır indirimi `Adj` `Type: 2` tutarı eksi mi (wiki örneği yalnız yüzdesel).
5. `GetEFTAuthorisation` taksit `0` = peşin mi.
6. Ürün adı 20, fiş altı satırı 32 karakter sınırı T300'de doğru mu.
7. Kartlı fişte banka slibi kendiliğinden basılıyor mu (`CloseReceipt(false)`).
8. `GetLastDocumentInfo` belge/Z numarası; `GetDailySummary` alanları
   (`Credit` = kart mı) basılı Z raporuyla aynı mı.
9. Eşleme her açılışta tekrarlanabiliyor mu; `SerialNum` (anakart özeti)
   değişmeden kalıyor mu.
10. `System.Data.SQLite` yerel parçası (`SQLite.Interop.dll`) gerekiyor mu —
    gerekirse `Connect` `DllNotFoundException` verir.
11. Kart beklerken 4,5 sn soket okuma süresi sorun çıkarıyor mu.
