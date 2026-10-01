# 0030 — "Kontrol merkezi": koyu tema, menü şeridi, akış bandı ve görünür hiyerarşi

- Tarih: 2026-10-01
- Durum: Kabul (ürün sahibi onayı: 2026-10-01 — üç tasarım yönü sunuldu, "B ile ilerle")
- Önceki kararlar: ADR-0017 (tasarım temeli, gruplu menü, mobil gezinme), ADR-0018 (Bugün ekranı),
  ADR-0029 (lead takımı)
- Değiştirdiği kararlar: ADR-0017 §1'deki açık tema ve "karanlık mod yok" ekip kararı; ADR-0017 K2-A'nın masaüstü
  görünümü (248 px yan menü). Menü ağacı, rol süzgeci ve mobil gezinme (K7-A) aynen geçerlidir.

## Bağlam
Ürün sahibi panelin genelini beğenmedi. Şikâyetler: hiyerarşi görünmüyor, ekranlar kalabalık ve okunması zor,
yerleşim zayıf, görünüm düz ve sıradan. Üç yön hazırlandı (A "Sakin odak", B "Kontrol merkezi", C "Akış");
ürün sahibi B'yi seçti.

Eski kabukta 20 sayfa tek sütunda alt alta duruyordu; Bugün ekranı iki eşit ağırlıklı karttan oluşuyordu ve işin
hangi aşamada durduğu hiçbir yerde görünmüyordu. Lead takımı sayfasında 50 ajanın hiyerarşisi yalnızca metinle
anlatılıyordu.

## Karar

### 1. Koyu tema, tek tema (`web/app/globals.css` `@theme`)
- Zemin `#0b0e1a`, panel `#0f1324`, ikincil yüzey `#151a33`, yükseltilmiş yüzey `#1a2040`.
- Metin: ink `#e9ebf7` (15,6:1), ink-2 `#c5c9e3` (11,3:1), ink-3 `#a3a9c9` (8,0:1) — panel zemini üzerinde.
- Marka rolleri ayrıldı: `brand-600` (`#6c58e8`) **dolgudur** (düğme zemini; beyaz metin 5,0:1), `brand-700`
  (`#b3a8ff`) koyu zeminde **metindir** (8,6:1). Marka rengi durum ifade etmez.
- Durum tonları (ok, warn, bad, info) koyu zemin / kenar / açık metin üçlüsüne çevrildi. Amber hâlâ "bir insandan
  eylem bekleniyor" demektir.
- Sayfalarda doğrudan kullanılan Tailwind paletleri (`slate`, `rose`, `amber`, `emerald`, `violet`, `neutral`)
  `@theme` içinde **ters çevrilmiş rampalarla** yeniden tanımlandı: 50–300 koyu zemin ve kenar, 600–900 açık metin.
  Böylece `bg-rose-50 text-rose-800 border-rose-200` gibi sınıflar sayfalar tek tek değiştirilmeden doğru okunur.
- Açık tema seçeneği **yoktur**. İki temayı birlikte sürdürmek her bileşende iki kontrast denetimi demektir; ürün
  sahibi tek yön seçti.
- Reklam taslağındaki görsel yer tutucu (`.ad-art`) kendi açık renklerini taşır; çevresindeki kart koyudur.
- Giriş alanları panel zemininden bir ton koyudur (`canvas`), böylece kartın içinde çukur görünür.
- `color-scheme: dark`: tarih seçici, açılır liste ve kaydırma çubuğu gibi yerel denetimler koyu çizilir.

### 2. Yazı tipleri
Red Hat Text (gövde), Red Hat Display (başlık ve vurgulu sayılar), Red Hat Mono (rakamlar). `@fontsource`
paketlerinden yerel yüklenir; derleme ve çalışma sırasında ağ gerekmez (ADR-0017 ile aynı kural). Arapça için
IBM Plex Sans Arabic kalır (Red Hat ailesinde Arap yazısı yok).

### 3. Masaüstü gezinme: menü şeridi + bölüm menüsü (`_components/rail-nav.tsx`, `_lib/nav-tree.ts`)
- 76 px'lik şeritte **en çok sekiz hedef** vardır; her hedef simge **ve görünür ad** taşır (yalnızca simge yok).
- Günlük işler (Bugün, Onaylar, Lead'ler) doğrudan hedeftir. Diğer gruplar (Reklamlar, Testler, Kampanyalar,
  Performans, Ayarlar) tek hedefe iner; hedef etkinken grubun sayfaları 216 px'lik **bölüm menüsünde** listelenir.
- Tek sayfası kalan grup (ör. hasta koordinatöründe Performans → yalnızca Uyarılar) o sayfanın adı ve simgesiyle
  görünür, bölüm menüsü açmaz.
- Rozetler (onay, lead, uyarı) şeritte grubun toplamı olarak, bölüm menüsünde sayfanın yanında görünür.
- Menü ağacı ve rol süzgeci değişmedi (`NAV_TREE`, `navTreeFor`); şerit bu ağaçtan türetilir (`railItemsFor`,
  `activeRailKey`). Menüden gizlemek güvenlik sınırı değildir; yetki her API ucunda ayrıca denetlenir.
- Telefon ve tablette (≤1023 px) şerit yoktur; alt sekme çubuğu ve tam ekran menü (K7-A) aynen kalır.

### 4. Bugün ekranı (`app/page.tsx`, `_components/today-board.tsx`, `_lib/today.ts`)
- **Akış bandı** (`todayPipeline`): Taslak → Onay bekliyor → Yayında → Lead → Randevu → Açık uyarı. Her hücre o
  aşamadaki kayıt sayısını gösterir ve ilgili sayfaya gider. Sıfır olan hücre sönük, dolu hücre parlaktır; yayındaki
  iş mor, bir insandan eylem bekleyen aşama amberdir. Rolün göremediği aşama bantta yer almaz; onay sayısı Onaylar
  kutusuyla aynı kapsamı kullanır.
- **Üç panel:** Sizden beklenenler (ilk iş büyük kartta, diğerleri sıkı satırlarda; satır başına tek eylem),
  Performans (dört gösterge + son 7 günün kampanya getirisi çubukları) ve Lead takımı (direktör → yedi takım →
  "Sizin onayınız").
- Modül hâlâ hiçbir kaydı değiştirmez.

### 5. Lead takımı sayfası (`app/lead-team/org-chart.tsx`)
Hiyerarşi şema olarak çizilir: direktör üstte, yedi takım lideri ortak çizgiden iner, her liderin altında uzmanları
durur. Direktörün yanında "Sizin onayınız" kutusu, kararın bir insanın onayı olmadan uygulanmadığını gösterir
(ADR-0029 §4). Ajan durumu renkli noktayla birlikte ekran okuyucu metniyle de verilir.

### 6. Erişilebilirlik
- Tüm metin çiftleri WCAG AA (4,5:1) sınırının üstündedir; giriş kenarı ve odak halkası ≥3:1.
- Renk tek başına anlam taşımaz: ton her yerde görünür metin ya da ekran okuyucu metniyle birlikte verilir.
- Odak halkası `#a093ff`, koyu zeminde 2 px.
- Şerit hedefinde `aria-current`: sayfanın kendisi açıkken `page`, bölümün içindeki bir sayfa açıkken `true`.

## Reddedilen seçenekler
- **A "Sakin odak" ve C "Akış":** ürün sahibi B'yi seçti.
- **Açık + koyu tema birlikte:** iki kat kontrast ve görsel denetim; istenmedi.
- **Yalnızca simgeli şerit:** simgeler tek başına anlaşılmıyor (ADR-0017 "her ikonun yanında görünür etiket").
- **Sayfalardaki palet sınıflarını tek tek değiştirmek:** 400'den fazla kullanım; rampaları belirteç düzeyinde
  çevirmek aynı sonucu tek yerde verir ve geri alınması kolaydır.

## Sonuçlar
- Yeni sayfalar renk için yalnızca belirteç sınıflarını kullanır (`text-ink`, `bg-surface`, `border-line`,
  `text-warn` …). `bg-white`, sabit onaltılık renk ve `text-black` kullanılmaz.
- Palet sınıfı kullanılırsa rampanın ters olduğu bilinmelidir: `*-50` koyu zemin, `*-800` açık metindir.
- Ürün adı kodda yazılmaz; şeritteki marka simgesinin adı `APP_NAME` değerinden gelir.
