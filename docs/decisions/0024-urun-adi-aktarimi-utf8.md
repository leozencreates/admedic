# 0024 — Ürün adının Tauri'ye aktarımında kodlama güvenliği

- Tarih: 2026-09-30
- Durum: Kabul (ürün sahibi onayı: 2026-09-30, "kök nedeni düzelt", hedef yazım `Stüdyosu`)
- Önceki kararlar: ADR-0003 (Windows masaüstü / Tauri), ADR-0023 (sunucu merkezli mimari; §Güncelleme `dev-up.ps1` kodlama notu)
- Kural: `AGENTS.md` (ürün adı kodda sabit yazılmaz), `docs/spec.md` §9

## Bağlam

Ürün adı kuralı gereği kod tabanında hiçbir yere sabit yazılmaz; tek kaynak `APP_NAME` ortam
değişkenidir (ADR-0003, durum notu 2026-09-26; `AGENTS.md`; `apps/api/src/lib.ts`). Masaüstü paketinde
bu değer `tauri.conf.json`'a yazılmadığı için `--config` ile geçiriliyordu:

```
"build:ci": "tauri build --config \"{\\\"productName\\\":\\\"$APP_NAME\\\"}\""
```

Bu yol iki kırılganlığı birlikte içeriyordu:

1. **Kabuk üzerinden aktarım.** Değer, pnpm'in Windows'ta kullandığı kabuk emülasyonu üzerinden
   genişletilip JSON'un içine dize olarak gömülüyordu. Geliştirme makinesinde sistem ANSI kod sayfası
   **1254** (Türkçe), konsol çıktı kodlaması **ibm857**; `ü` gibi karakterler bu katmandan geçerken
   bozulabiliyor.
2. **Örnek komut yalnızca POSIX'te geçerliydi.** `desktop/README.md` tek satır öncesi atama
   örneği veriyordu (`APP_NAME="…" pnpm …`). Bu ön ek cmd.exe'de genişlemez (`$APP_NAME` literal kalır)
   ve PowerShell'de de geçersizdir; yani dokümana uyan kullanıcı zaten hatalı değeri hiçbir yere
   aktarmadan derlemeyi deneyebilirdi.

Bu, depoda daha önce yaşanmış bir sınıf hatadır: ADR-0023'te `dev-up.ps1` için "Betik yalnızca ASCII
karakterlerle yazıldı. Windows PowerShell 5.1, BOM'suz UTF-8 dosyayı Türkçe ANSI kodlamasıyla okuyordu"
notu düşülmüştü. Aynı varsayım (Türkçe Windows + BOM'suz UTF-8) masaüstü paketleme yolunda da geçerliydi.

### Doğrulanan bulgu ve sınırı

Şüpheli metin (`Klinik Reklam StÃƒÂ¼dyosu`) **depoda hiçbir dosyada bulunmadı**; tüm kaynaklar geçerli
UTF-8, `desktop/README.md` doğru yazımlıydı. Aynı sistemde kod sayfası 1254 ile iki katman yanlış
çözümleme, `Stüdyosu` → `StÃ¼dyosu` → `StÃƒÂ¼dyosu` dönüşümünü birebir üretiyor; yani gözlenen metin
**görüntüleme/taşıma katmanından** (ör. konsola `type`/`cat` ile basıp kopyalama) geliyordu.

Ayrıca bu makinede `cargo` kurulu değil (`src-tauri/target/` yok), yani burada hiçbir Tauri derlemesi
çalışmamıştır; bozuk ad bir derleme çıktısından gelmiş olamaz. Bu nedenle aşağıdaki karar **gözlenen
metnin kaynağını değil**, onu üretebilecek gerçek ve doğrulanabilir yapısal hatayı kapatır.

## Karar

### 1. `build:ci` kabuk üzerinden değer geçirmez
`desktop/package.json` → `"build:ci": "node scripts/build-ci.mjs"`.

Yeni `desktop/scripts/build-ci.mjs`:
- `APP_NAME`'i doğrudan `process.env`'den okur, boşsa anlaşılır hata verip **çıkış kodu 1** ile çıkar;
- `{ "productName": … }` değerini geçici bir **UTF-8 JSON dosyasına** yazar (`writeFileSync(..., 'utf8')`);
- Tauri'ye dosya yolunu `--config <yol>` olarak **argv içinde** geçirir; kabuk hiç devreye girmez;
- Tauri CLI'yi `node_modules/.bin/tauri.cmd` yerine `process.execPath` + çözümlenen `bin` yoluyla
  çağırır — `.cmd` sarmalayıcısını atlayarak ikinci bir kod sayfası katmanını da ortadan kaldırır;
- `finally` ile geçici dizini temizler, Tauri'nin çıkış kodunu olduğu gibi döndürür.

Tauri `--config` seçeneğini "JSON strings or paths to JSON, JSON5 or TOML files" olarak belgeliyor;
verilen dosya `tauri.conf.json` ile **birleştirildiği** için yalnızca `productName` ezilir, `bundle`
hedefleri ve ikonlar korunur. `tauri.conf.json`'a hiçbir ad yazılmadığı için **ADR-0003 ad kuralı
korunur**; `scripts/build-ci.mjs` içinde de hiçbir ürün adı sabit yoktur.

### 2. Doküman platforma göre ayrılır
`desktop/README.md` üretim paketi bölümü iki ayrı örnek verir: PowerShell (`$env:APP_NAME = "…"; pnpm …`)
ve bash/zsh (`APP_NAME="…" pnpm …`). POSIX tek satır öncesi atamanın cmd.exe/PowerShell'de geçersiz
olduğu ve bozulmaya yol açtığı uyarı olarak yazılır.

### 3. Kodlama politikası
- **PowerShell/`.cmd` betikleri:** ASCII-only (ADR-0023 `dev-up.ps1` uygulaması).
- **Kod dosyaları (`.ts`/`.tsx`/`.js`/`.json`/`.rs`):** BOM'suz UTF-8 kalır; BOM bazı ayrıştırıcıları bozar.
- **Markdown/doküman:** UTF-8 **BOM**, kök `.editorconfig` üzerinden `[*.md] charset = utf-8-bom` kuralıyla.
- **Terminal okuma:** BOM tek başına yeterli değildir. Windows konsolunda UTF-8 çıktı için
  `chcp 65001` gerekir; aksi hâlde konsol 1254/857'de kalır ve doğru metin bile bozuk görünür.

### 4. Normallestirme kapsamı
`.editorconfig` yalnızca dosya **kaydedilirken** kodlamayı etkiler; depoda hâlâ BOM'suz duran
dosyalara kendiliğinden dokunmaz. Bu yüzden kural tek başına bırakılmamıştır:

- **BOM eklenen (31 dosya):** `README.md` ve `docs/**` (`docs/decisions/` 24 ADR dahil).
  Uygulama sırasında her dosya için "BOM çıkarıldıktan sonra içerik orijinalle bayt bayt aynı mı"
  denetimi yapıldı; 31/31 dosyada geçti, içerik değişmedi.
- **BOM'suz bırakılan istisna (4 dosya):** `AGENTS.md`, `web/AGENTS.md`, `legacy/CLAUDE.md`,
  `web/CLAUDE.md`. Bunlar ajan araçlarının ayrıştırdığı talimat dosyalarıdır; Next.js
  `generate-agent-files.js` `AGENTS.md` bloklarını yeniden yazar ve BOM ilk satırda görünür
  karaktere dönüşebilir. `.editorconfig` içinde `[AGENTS.md]` / `[CLAUDE.md]` ile
  `charset = utf-8` açıkça sabitlendi; kural bu dosyaları kapsam dışı bırakır.
- Eski `admedic/` klonunda yalnızca kural eklendi, mevcut `.md` dosyaları normalleştirilmedi
  (eski kopya, kapsam genişletilmedi).

## Sonuçlar

- **Doğrulama (bu ortam):**
  - `ü` baytları dosyada doğru yazılıyor: `…5374c3bc64796f73…`, gidiş–dönüş eşit, dosya geçerli UTF-8.
  - `desktop/package.json` geçerli JSON; `build:ci` yeni adıma işaret ediyor.
  - `APP_NAME` boşken net hata ve çıkış kodu 1 doğrulandı (her iki klon).
  - Tauri CLI 2.11.4 çalışıyor; `--config` dosya yolu desteği CLI yardım metniyle doğrulandı.
  - Uçtan uca zincir denendi: `scripts/build-ci.mjs` Tauri'yi buldu, UTF-8 yapılandırmayı yazdı,
    `--config <yol>` ile geçirdi ve Tauri yapılandırmayı kabul edip `cargo metadata` aşamasına geçti.
    Orada `cargo: program not found` ile durdu (Rust toolchain kurulu değil).
- **Doğrulanmayan:** Gerçek paketleme çıktısı (`nsis`/`msi` üretimi) ve ürün adının nihai arayüz
  adında görünmesi. `cargo` bu makinede kurulu olmadığı için derleme yapılamadı; ADR-0003'teki
  "doğrulanamayan kod yazma" ilkesi gereği bu karar paketlemeyi doğrulamış sayılmaz. İlk paketleme
  Rust toolchain'i olan bir makinede yapılmalı ve üretilen dosya adı ayrıca kontrol edilmelidir.
- **Pozitif:** Ürün adı artık hiçbir kod sayfasına bağlı değil; Türkçe karakterli adlar üretim
  adımında güvenli. Doküman artık platformun gerçekten çalıştırabildiği komutu gösteriyor.
- **Negatif:** `build:ci` artık bir Node adımı gerektiriyor (`node` ön koşulu). Ek dosya
  (`desktop/scripts/build-ci.mjs`) ve ADR-0003'teki "tek komut" sadeliğinden küçük bir sapma.
- **BOM maliyeti:** Her Markdown dosyası ilk satırında görünmez bir bayt taşır; bazı diff
  araçlarında ilk satır değişmiş gibi görünür. Kapsam bilinçli olarak daraltıldı (§4) ve istisna
  `.editorconfig` ile kodlandı. Depo geneline `charset = utf-8-bom` yaymak yerine yalnızca
  dokümanlar kapsam altına alındı.

## Kapsam notu

### Güncelleme (2026-10-01): UTF-8 dosyasından ad okuma ve aktarım testleri

- Masaüstünde bildirilen logo/marka yazısı için yeniden incelendi: kök `.env` içindeki `APP_NAME`,
  masaüstü HTML/JavaScript metinleri ve API kaynakları geçerli UTF-8; kaynaklarda bozuk Türkçe metin bulunmadı.
  Depodaki ikon görseli yazısızdır; web panelindeki marka yazısı `APP_NAME` değerinden üretilir.
- `build:ci` yalnızca süreç ortamını okuyordu. Kök `.env` doğru olsa bile ayrıca terminal ataması
  gerekiyordu. Artık süreçte `APP_NAME` tanımlı değilse kök `.env` açık UTF-8 okuma ve `dotenv.parse`
  ile çözümlenir; yalnızca `APP_NAME` kullanılır. Süreç ortamındaki açık değer önceliklidir.
- Kabuksuz CLI ve UTF-8 JSON aktarımı korunur. Betik artık `process.exitCode` kullanır; önceki
  `process.exit` çağrısı `finally` bloğunu atladığı için kalan geçici yapılandırma dosyası temizlenir.
- `test:encoding`, gerçek Node alt süreciyle tüm Türkçe harflerin eksiksiz aktarımını ve hata durumlarını
  sınar. API testi de masaüstünün tükettiği `/v1/overview` yanıtında UTF-8 başlık ve ham JSON baytlarını denetler.
- Bu değişiklik yeni bir geliştirme fazı veya mimari değişiklik değildir; mevcut ad aktarımı düzeltmesini tamamlar.
- Doğrulama: aktarım testleri 10/10; API testleri 11 geçti, veritabanı gerektiren 4 test atlandı;
  API tip denetimi ve lint geçti. Çalışan panelin HTTP yanıtı ve Chromium'da marka yazısı
  `Klinik Reklam Stüdyosu` olarak doğru görüldü. Gerçek Tauri CLI yapılandırmayı kabul edip
  `cargo metadata` aşamasına ulaştı; Cargo bulunamadığı için paketleme orada durdu.
- Sınır: Windows masaüstü paketi bu makinede bulunamadı; Rust/Cargo kurulu olmadığı için `.exe` paketlemesi
  doğrulanamadı. Kullanıcının gördüğü bozuk logonun hangi kurulu paket veya pencereye ait olduğu henüz doğrulanmış değil.

Bu karar kanonik depoya (`main`, HEAD `9ddc056`) uygulandı. Çalışma dizininde ayrıca bulunan
`admedic/` altındaki eski klon (`HEAD 08fe03b`, 2026-09-29) aynı hatalı `build:ci` komutunu taşıyordu;
oraya da aynı düzeltme uygulandı. Bu klon artık dosyalar (build çıktısı) içeriyor ve çalışma ağacında
izlenmiyor; kalıcılığı kullanıcı kararına bırakıldı.
