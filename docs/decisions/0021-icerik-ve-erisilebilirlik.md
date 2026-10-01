# 0021 — İçerik taraması, boş durum anlatımları ve otomatik erişilebilirlik kapısı (Faz 6)

- Tarih: 2026-09-28
- Durum: Kabul (ürün sahibi onayı: 2026-09-28, Faz 6 planı)
- Önceki kararlar: ADR-0016 (K1–K11), ADR-0017–0020 (Faz 2–5)
- Uygulanan kararlar: K9-C (Türkçe birincil terimler), K10-A (sade-profesyonel ton), K11-B (önce kritik akışlar ve
  ortak bileşenler, sonra kademeli; otomatik axe kontrolü), K6-B (tanıtım yalnızca boş durumda)

## Karar

### 1. Metin taraması (tüm sayfalar, üç ekip)
- **Temizlenenler:**
  - büyük harfli etiketler ve slogan başlıklar (oturum açma sayfasındaki karşılama bandı dahil);
  - bağlantı ve düğme metinlerindeki "→ / ←" okları;
  - eski sayfa adları ("Lead CRM", "Kreatif …", "Kampanya Planlayıcı", "Genel Bakış");
  - "ad set" ve "Instant Form" (yerine "reklam seti" ve "Anında Form");
  - ekranda kalan İngilizce kelimeler;
  - elle yapılan para, sayı ve yüzde biçimlemesi (artık `format.ts` kullanılıyor).
- **İstemci hata metinleri** "ne oldu + ne yapmalı" biçimine getirildi. Örnek: "Kaydedilemedi. Tekrar deneyin."
  metni "Rızanın geri çekildiği kaydedilemedi. Bağlantınızı kontrol edip tekrar deneyin." oldu.
- **API hata metinleri:** 120 farklı metin, 173 çağrı yerinde (58 dosya) aynı biçime getirildi. HTTP kodları,
  koşullar ve mantık değişmedi.
  - Ham kodlar metinden çıkarıldı: `OWNER/ADMIN`, `PAUSED`, `${lead.status}` gibi değerler yerine rol ve durum
    adları kullanılıyor.
  - Örnek: "Kampanya bulunamadı." metni "Kampanya bulunamadı; silinmiş olabilir. Kampanyalar sayfasından yeniden
    açın." oldu.
  - Aynı biçim şu dosyalardaki eski kopyalara da uygulandı: `capi-sync`, `ad-review-sync`, lead asistanı ve
    worker'ın SMS metni.
- **Oturum açma sayfası:**
  - Uygulama adı `APP_NAME` değişkeninden okunur.
  - "Çalışma alanı ID" etiketi "Çalışma alanı kimliği" oldu.
  - Metinler `i18n.ts` sözlüğünde; kullanılmayan `login.eyebrow` ve `login.title` anahtarları silindi.
  - Giriş sayfasının `main` öğesi seçili arayüz dilini bildiriyor.

### 2. Boş durum anlatımları (K6-B)
Veri yokken sayfa ne işe yaradığını ve ilk adımı `IntroPanel` ile anlatıyor. Bu, şu sayfalarda uygulandı:
Bugün (analist/izleyici), Onaylar, Uyarılar, Ajan kararları, Öneriler, İçgörüler, Kampanyalar, Lead'ler,
Reklam oluştur, Reklam kütüphanesi, Çok dilli üretim, A/B testleri, Klinik ve marka, Meta bağlantıları,
Platformlar ve İçerik kuralları.
- Birincil eylem yalnızca o eylemi yapabilen role gösterilir (Reklam kütüphanesi ve A/B testleri artık `canCreate`
  alıyor).
- Süzgeç sonucu boş kaldığında "Süzgeçle eşleşen … yok" metni ve "Süzgeçleri temizle" gösterilir.

### 3. Erişilebilirlik
- **Otomatik kapı (`web/e2e/a11y.pw.ts`):**
  - Kapsam: 24 sayfa, iki boyutta (1366×768 ve 390×844). Sayfalar: tüm menü sayfaları, lead ayrıntısı, kampanya
    sayfası ve Performans sekmesi, oturum açma.
  - Kurallar: axe-core, WCAG 2.1 A ve AA.
  - Ayrıca aranan: yatay taşma, HTTP hatası, sayfa hatası.
  - Test kendi fikstürünü kurar ve bitince siler. Oturum çerezi doğrudan yazılır.
  - Çalıştırma: `STUDIO_E2E=1 pnpm --filter web test:e2e`. Önceden kurulu bir Chromium için `PW_CHROMIUM_PATH`
    verilebilir (`playwright.config.ts`).
  - Yeni bir ihlal girerse test kırılır.
- **Klavye denetimi** (Reklam oluştur, A/B testleri, test ayrıntısı, Test hesaplayıcı, Uyarılar, Klinik ve marka):
  - Tab sırası sayfa içeriğine ulaşıyor.
  - Her durakta bir erişilebilir ad ve görünür odak halkası var. Tek istisna üst çubuk araması: halka kutunun
    kendisinde değil, çevresinde (`:focus-within`) çiziliyor.
- **Ekran okuyucu yapısı:** 23 sayfanın her birinde tek h1, atlamasız başlık sırası ve tek `main` var.
- **Ekiplerin düzelttikleri:**
  - Uyarı ve öneri düğmelerine kaydın adı eklendi (`sr-only` / `aria-describedby`).
  - Durum bildirimleri kalıcı `role="status"` bölgelerine taşındı.
  - Yalnızca renkle anlatılan durumlara metin eklendi (içerik kontrolü riski, düzenlenen hizmet, planın dilleri
    dışındaki içerik).
  - Süs amaçlı çubuklara `aria-hidden` verildi.
  - Faturalar sayfasının yüklenme ve hata durumlarına h1 eklendi.

### 4. Çeviri altyapısı taslağı
`docs/i18n-sayfa-metinleri.md`: bölüm sözlükleri, `useT`, `format.ts` ve `labels.ts` için dil desteği, API hata
kodları ve geçiş sırası. Taslak uygulanmadı; önceliklendirme ürün sahibinde.

## Sonuçlar
- **Doğrulama:**
  - web: tip denetimi ve eslint temiz; 40 test dosyası ve 253 test geçti (DB dahil).
  - `workers/meta-sync`: 27 test geçti.
  - e2e: erişilebilirlik kapısı (2 test, 24 sayfa × 2 boyut) ve Reklam oluştur akışı (`studio.pw.ts`) geçti.
    `studio.pw.ts` iki noktada güncellendi: çıkış artık hesap menüsünde, giriş alanının etiketi "Çalışma alanı
    kimliği".
  - Güncellenen test beklentileri (yalnızca metin): `campaign-publish.test.ts`, `capi.integration.test.ts`,
    `org-settings.integration.test.ts`.
- **Yeni geliştirme bağımlılığı:** `axe-core` 4.13.
- **Açık terim kararları (ürün sahibi):**
  - Menü "A/B testleri" diyor; Reklam oluştur ve test ekranları ise "deney" diyor ("A/B deneyi oluştur").
    Tek bir terime inilecekse karar verilmeli; e2e testi bu metinlere bağlı.
  - "AI" kısaltması ürün terimi olarak bırakıldı. "Yapay zekâ" istenirse bütün üründe değiştirilir.
- **Bilinen noktalar:**
  - Demo verisindeki bazı kayıt adları İngilizce ("Creative #10 …", "Germany - Hair Restoration"). Bunlar kodda
    değil, tohum verisinde.
  - Çözümü bağlama göre değişen birkaç API metni olduğu gibi bırakıldı: "Kapalı konuşma devralınamaz.",
    "Kayıp lead'e dönüşüm gönderilemez."
