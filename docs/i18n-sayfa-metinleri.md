# Sayfa metinlerinin çevirisi — altyapı taslağı (Faz 6)

- Durum: Taslak (uygulanmadı; ürün sahibinin önceliklendirmesini bekliyor)
- İlgili: spec §4 (arayüz dilleri TR ve EN), ADR-0009 §6 (reklam dilleri ayrıdır), ADR-0017, ADR-0021

## Bugün
- `web/app/_lib/i18n.ts` içinde TR/EN sözlüğü var; ancak yalnızca şunlar çevriliyor:
  - kabuk: menü, üst çubuk, alt sekme çubuğu, hesap menüsü;
  - sayfa başlıkları (sekme adları);
  - oturum açma sayfası;
  - lead durumları.

  Dil `ui-lang` çerezinden okunuyor.
- Sayfa gövdeleri Türkçe ve metinler kodun içine yazılmış (yaklaşık 3.000 metin, 60+ dosya). Bu yüzden kabuk
  `main lang="tr"` bildiriyor.
- Durum etiketleri (`labels.ts`) ve biçimler (`format.ts`, tr-TR) Türkçe.
- API hata metinleri Türkçe; sunucu ekrana gösterilecek metni kendisi döndürüyor.

## Önerilen yapı
1. **Bölüm sözlükleri.** Tek büyük sözlük yerine her bölümün kendi dosyası olur:
   - `web/app/_i18n/tr/<bölüm>.ts` ve `web/app/_i18n/en/<bölüm>.ts`;
   - bölümler: `shell`, `today`, `approvals`, `leads`, `campaigns`, `studio`, `tests`, `insights`, `settings`,
     `errors`.

   Anahtar tipi TR dosyasından türetilir (`keyof typeof tr`). EN'de eksik anahtar derleme hatası verir; bu,
   bugünkü `Record<TranslationKey, string>` desteninin bölümlere yayılmış hâlidir.
2. **Değişkenli metinler.** Metne değer gömmek için `t("leads.waiting", { count, duration })` biçimi kullanılır;
   tekil/çoğul ayrımı `Intl.PluralRules` ile yapılır. Tarih, sayı ve para zaten `format.ts` üzerinden geçiyor;
   bunlara dil parametresi eklenir (tr-TR / en-GB). Saat dilimi Europe/Istanbul kalır.
3. **Sunucu ve istemci.**
   - Sunucu bileşenleri `uiLanguage()` ile dili okur (bugünkü `page-meta.ts`).
   - İstemci bileşenleri kök düzenin sağladığı bir `LanguageProvider` bağlamından `useT()` ile okur.
   - Dil değişince `router.refresh()` (bugünkü `LanguageSwitcher`) ile iki taraf da yenilenir.
   - Render sırasında tarayıcı depolaması okunmaz (hydration uyumsuzluğu oluşmasın).
4. **Durum etiketleri.** `labels.ts` işlevleri isteğe bağlı bir `lang` parametresi alır. Bu desen `leadStatusStyle`
   işlevinde zaten var.
5. **API hataları.** Sunucu Türkçe metne ek olarak kararlı bir hata kodu döner
   (`{ error, code: "CAMPAIGN_NOT_FOUND" }`). İstemci bu kodu `errors` sözlüğünde arar. Kod sözlükte yoksa sunucu
   metni gösterilir. Böylece sunucu metinleri kademeli taşınır ve eski istemciler bozulmaz.
6. **Hasta ve reklam içeriği.** Bu içerikler hiçbir zaman çevrilmez. Kendi dil etiketleriyle gösterilmeye devam
   eder (`lang`, Arapça için `dir="rtl"`).
7. **Denetim.** Her iki dilde de otomatik erişilebilirlik kapısı çalışır (`e2e/a11y.pw.ts` bir `lang` döngüsü alır).
   Ayrıca bir birim testi, bileşen dosyalarında Türkçe harf içeren serbest JSX metni kalıp kalmadığını tarar.

## Geçiş sırası (önerilen)
Her adım ayrı yayınlanabilir; bitmemiş bölümler Türkçe kalır ve o bölümün `main` öğesi `lang="tr"` bildirir.

1. Altyapı: bölüm sözlükleri, `useT`, `format.ts` dili, `labels.ts` dili ve hata kodları.
2. Ortak parçalar ve yüksek trafikli ekranlar: Bugün, Onaylar, Lead'ler.
3. Kampanyalar, Reklam oluştur, A/B testleri.
4. Ayarlar, İçgörüler, Öneriler, Uyarılar.

## Karar gerektirenler
- EN arayüzü için hedef kitle kim olacak (klinik personeli mi, ajans mı)? Terimler buna göre seçilecek.
- API metinlerinin kodlu biçime geçişi, masaüstü (Tauri) istemcisiyle birlikte mi yapılacak?
- Önceliklendirme: çeviri, canlıya geçiş işlerinden (remaining-work §0) önce mi, sonra mı?
