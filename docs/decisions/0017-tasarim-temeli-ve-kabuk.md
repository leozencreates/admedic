# 0017 — Tasarım temeli, gruplu menü, üst çubuk ve mobil gezinme (Faz 2)

- Tarih: 2026-09-28
- Durum: Kabul (ürün sahibi onayı: 2026-09-28, "Faz 2 planını onaylıyorum")
- Önceki karar: ADR-0016 (K1–K11 kararları ve Faz 1)
- Uygulanan kararlar: K1-B (Operasyon odası), K2-A (iş alanına göre gruplu menü), K6-B (kompakt başlık),
  K7-A (mobil alt sekme çubuğu), ekip kararları (Lucide, IBM Plex, karanlık mod yok)

## Bağlam
Faz 1 bugünkü ekranlardaki kırık ve yanıltıcı noktaları düzeltti, ama kabuk hâlâ şöyleydi:
- 19 öğelik düz bir menü; her rol her şeyi görüyordu.
- Mobilde bir "Menü" düğmesi vardı, alt sekme çubuğu yoktu.
- Sayfaların çoğu büyük bir tanıtım bandıyla açılıyordu (`.studio-hero`, slogan başlık, büyük harfli üst etiket).
- Renkler ve ölçüler sayfalara dağılmış Tailwind sınıflarıydı; yazı tipi sistem fontuydu.

## Karar

### 1. Tasarım belirteçleri (`web/app/globals.css` `@theme`)
- **Yüzey ve metin:** canvas, surface, subtle, ink / ink-2 / ink-3, line, btn-line.
- **Marka:** brand-50…700 (#5B45D0). Marka rengi hiçbir durumu ifade etmez.
- **Koyu menü:** nav, nav-fg, nav-active.
- **Durum tonları:** ok, warn, bad, info, neutral; her biri zemin, kenar ve metin değeriyle. Amber, bir insandan
  eylem beklendiği anlamına gelir.
- **Diğer:** yarıçap (6 / 8 / 12), iki gölge (açılır panel, diyalog).
- **Eski adlar** (`muted`, `brand`, `brand-strong`, `pill`, `input`) yeni değerlere bağlandı. Faz 1 sayfaları
  değişiklik gerektirmeden yeni temaya geçti.
- **Kontrast (beyaz zeminde):** ink-2 7,6:1, ink-3 4,8:1, brand-600 6,6:1, giriş kenarı 3,4:1.
- **Yazı tipi:** IBM Plex Sans ve IBM Plex Sans Arabic (400/500/600), `@fontsource` paketlerinden yerel olarak
  yüklenir. Derlemede ve çalışmada ağ gerekmez, Windows masaüstü paketi de çevrimdışı çalışır. Sayılar
  `tabular-nums` ile hizalanır.
- **Ortak stiller:**
  - Düğmeler: `primary-button`, `secondary-button`, `ghost-button`, `danger-button`. Yükseklik masaüstünde
    36 px, telefonda 44 px. Pasif düğmenin kendi görünümü var.
  - Diğer: `Badge` (belirteç tonları), `Card`, `.field` / `.input`, `.text-link`, `.count-badge`.
- **İkonlar:** `lucide-react`. Tüm ikonlar süs amaçlıdır (`aria-hidden`); yanlarında görünür bir etiket bulunur.

### 2. Menü ağacı (`web/app/_lib/nav-tree.ts`, saf modül)
Rotalar bu fazda değişmedi. Sayfaları sekmelerde birleştirme işi sonraki fazlara kaldı (Onaylar kutusu Faz 3,
kampanya sayfası Faz 5).

| Grup | Öğeler |
|---|---|
| (başlıksız) | Genel bakış · Onaylar · Lead'ler |
| Reklamlar | Reklam oluştur · Reklam kütüphanesi · Çok dilli üretim |
| Testler | A/B testleri · Test hesaplayıcı |
| Kampanyalar | Kampanyalar · Kampanya planlayıcı |
| Performans | İçgörüler · Öneriler · Ajan kararları · Uyarılar |
| Ayarlar | Klinik ve marka · Meta bağlantıları · Platformlar · Politika ve bütçe koruma · İçerik kuralları · Faturalar |

**Rol görünürlüğü.** Rolün iş yapamayacağı ve okumasına gerek olmayan sayfa menüde gösterilmez. Bu yalnızca
gezinmeyi sadeleştirir; yetki her API ucunda ayrıca denetlenir, yani menüden gizlemek bir güvenlik sınırı değildir.
- **Hesap sahibi, Yönetici:** tüm menü.
- **Reklam uzmanı:** Faturalar, Meta bağlantıları, Platformlar ve bütçe koruma dışında her şey.
- **Hasta koordinatörü:** yalnızca Lead'ler ve Uyarılar (ana sayfası Lead'ler).
- **Analist:** okuma sayfaları, Lead'ler ve Uyarılar; onay ve ayar sayfaları yok.
- **İzleyici:** Genel bakış, Reklam kütüphanesi, A/B testleri, Kampanyalar, İçgörüler.

**Diğer kurallar:**
- Menü etiketleri sayfa başlığı ve sekme adıyla aynıdır. Hepsi `i18n.ts` içindeki `nav.*` anahtarlarından gelir
  (TR/EN); sayfa adları cümle düzeninde yazılır.
- Etkin öğe en uzun önek eşleşmesiyle bulunur; kayıt sayfası (`/leads/<id>`) üst öğesini (Lead'ler) etkin gösterir.

### 3. Kabuk (`web/app/_components/app-shell.tsx`)
**Masaüstü:**
- **Yan menü:** koyu ve gruplu; kendi içinde kayar. Rozetler yalnızca bir insandan eylem bekleyen sayıları
  gösterir: Onaylar, yanıt bekleyen Lead'ler, açık Uyarılar.
- **Üst çubuk** (56 px), soldan sağa:
  - **Lead araması** (Ctrl/⌘+K ile odaklanır). `/leads?q=` adresine gider; Lead'ler sayfasındaysa sayfa
    yenilenmeden süzer.
  - **Ortam etiketi** ("Demo ortamı").
  - **"Yeni" menüsü:** reklam, kampanya, A/B testi; yalnızca düzenleme rolleri görür.
  - **Bildirim zili:** role göre süzülmüş son 8 açık uyarı; her biri ilgili kayda bağlanır.
  - **Hesap menüsü:** ad, rol, çalışma alanı, dil ve çıkış. Hesap bloğu yan menüden buraya taşındı.
- **Paneller:** açılır paneller Esc tuşuyla ya da dışarı tıklanınca kapanır, sayfa değişince de kapanır.

**Telefon ve tablet (1023 px ve altı):**
- **Yan menü:** gizlenir.
- **Üst çubuk:** sayfa adı, arama ikonu ve zil.
- **Alt sekme çubuğu** (64 px, K7-A): rol başına en çok 4 hedef ve "Menü".
  - Hesap sahibi / Yönetici: Genel bakış, Onaylar, Lead'ler, Kampanyalar.
  - Reklam uzmanı: Genel bakış, Reklam oluştur, Kampanyalar, İçgörüler.
  - Hasta koordinatörü: Lead'ler, Uyarılar.
  - Analist: Genel bakış, İçgörüler, Kampanyalar, Lead'ler.
  - İzleyici: Genel bakış, İçgörüler, Kampanyalar.
- **"Menü":** gruplu ağacı, hesabı, dili ve çıkışı tam ekran açar.
- **Klavye açıkken** (bir alana yazarken) alt çubuk gizlenir; sohbet yazma alanını örtmez.
- **Başlık:** sayfa adı üst çubukta yazdığı için sayfanın h1'i ekranda gizlenip yalnızca ekran okuyucuya bırakılır
  (çift başlık olmaz). Kayıt sayfalarında (lead adı, test adı) h1 görünür kalır.

**Rol ve sayılar:**
- Rol ilk çizimde sunucudan gelir (`layout.tsx` → `currentActor`), böylece menü doğru süzülmüş açılır.
- Sayılar ve bildirimler `/api/shell` ucundan gelir. Uç sayfa değişince ve sekme görünürken dakikada bir
  yeniden çağrılır.

### 4. `/api/shell` (salt okunur)
Kabuğun ihtiyaç duyduğu her şeyi tek çağrıda döndürür: kullanıcı adı (yoksa e-posta), baş harfler, rol etiketi,
çalışma alanı, sayılar ve en çok 8 bildirim. Tüm sorgular çalışma alanıyla sınırlıdır.
- **Onay sayısı:** yalnızca Hesap sahibi, Yönetici ve Reklam uzmanı için (`countPendingApprovals`).
- **Lead rozeti:** "Yanıt bekliyor" (NEW) lead'lerin sayısı; yalnızca hastayla yazışabilen roller için.
- **Uyarılar:**
  - Hasta koordinatörü yalnızca konuşma devri uyarılarını görür.
  - İzleyici hiçbir uyarı görmez.
  - Analist bildirimleri görür ama rozet almaz, çünkü uyarı üzerinde işlem yapamaz.
- Test: `web/tests/shell.integration.test.ts`. Kapsadığı durumlar: oturumsuz istek 401, başka çalışma alanının
  kayıtları sayılmıyor, her rolün süzgeci doğru.

### 5. Kompakt sayfa başlığı (K6-B, `PageHeader` ve `IntroPanel`)
- 25 sayfada `.studio-hero` tanıtım bantları, slogan başlıklar ("Bir sonraki iyi fikri verilerle bulun.",
  "Tahmin etmeyin. Karşılaştırın."), büyük harfli üst etiketler ve etiket şeritleri kaldırıldı.
- Yeni başlığın yapısı:
  - **Ekmek kırıntısı:** gruplu sayfalarda grup adı; kayıt sayfalarında üst sayfaya bağlantı.
  - **h1:** menüdeki ad ya da kayıt adı.
  - **Açıklama:** en fazla bir cümle.
  - **Eylemler:** en fazla bir birincil ve bir ikincil.
- Başlık dışındaki metin düzeltmeleri:
  - Bağlantı ve düğme metinlerinin sonundaki "→" okları kaldırıldı.
  - Büyük harfli bölüm etiketleri (BİLGİLER, MESAJLAR, HARCAMA…) cümle düzenine çevrildi.
  - Kullanılmayan `recommendation-library.tsx` silindi.
- `IntroPanel`, sayfanın ne işe yaradığını yalnızca veri yokken anlatmak için hazırdır. Bu fazda taşınması gereken
  uzun bir tanıtım metni çıkmadı.

## Sonuçlar
- **Yeni bağımlılıklar:** `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-sans-arabic` (5.3.0),
  `lucide-react` (1.48.0). Operatör `pnpm install` çalıştırmalı; `scripts\dev-up.cmd` paket kurmaz.
- **Etiket değişiklikleri:** "Lead CRM" → "Lead'ler", "Kreatif Üretimi" → "Çok dilli üretim",
  "Kayıtlı Deneyler" → "A/B testleri", "A/B Test Merkezi" → "Test hesaplayıcı",
  "Politika Kuralları" → "İçerik kuralları". Sekme başlıkları da buna göre değişti.
- **Doğrulama:**
  - web: tip denetimi ve eslint temiz; 34 test dosyası ve 226 test geçti (DB entegrasyonu dahil; yeni `nav-tree`
    ve `shell` testleri).
  - axe (wcag2a/aa/21aa): 22 rota × 1366×768 ve 390×844 = 44 sayfa yüklemesi; 0 ihlal, yatay taşma yok.
  - Etkileşim denetimi: Yeni / zil / hesap panelleri, Esc ve dışarı tıklama, Ctrl+K, arama → `/leads?q=`,
    mobil menü, yazarken alt çubuğun gizlenmesi, izleyicinin süzülmüş menüsü.
- **Açık işler (sonraki fazlar):**
  - Faz 3: "Bugün" ana sayfası ve birleşik Onaylar kutusu (Onaylar rozetinin anlamı orada kesinleşir; reklam
    uzmanı yalnızca kendi gönderdiklerini görecek).
  - Faz 4: lead gelen kutusu. Reklam uzmanının aktif konuşmayı devralma yetkisi (ADR-0016) burada ele alınacak.
  - Faz 5: kampanya sayfası.
  - Faz 6: içerik ve erişilebilirlik taraması.
  - Menü daraltma ve rota birleşmeleri (`/settings/*`, `/ads`) şimdilik yapılmadı.
- **Bilinen küçük nokta:** izleyicide "Kampanyalar" grubunun tek öğesi de "Kampanyalar" olduğundan menüde ad iki
  kez görünür. Faz 5'te kampanya sayfası birleşince çözülecek.
