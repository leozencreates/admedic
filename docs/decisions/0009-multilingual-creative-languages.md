# 0009 — Çok Dilli Kreatif Genişletmesi: FR/NL/PL + RTL Önizleme

- Tarih: 2026-09-26
- Durum: Kabul
- İlgili spec: 3.4

## Bağlam
Kreatif üretimi başlangıçta TR/EN/DE/RU/AR dillerini (P0) kapsıyordu; FR/NL/PL (P1) olarak işaretlenmişti. Spec 3.4, "kontrollü dil genişletmesi" der ve Arapça için RTL önizleme ister. RTL önizlemesi yalnız 5 bileşende inline `language === "AR" ? "rtl" : "auto"` ternary'leri olarak dağılmıştı; CSS katmanında RTL desteği (`.ad-art` `align-items: flex-start`) yoktu.

## Karar
1. **Dil kanonik listesi** `BriefSchema.language` enum'udur: TR, EN, DE, RU, AR, FR, NL, PL. `DraftSchema`/`DraftContent`/`Brief` tipleri buradan türetilir; tek noktadan değişiklik yeterlidir.
2. `LOCALIZATION` (llm promptları) eksiksizliği `Record<BriefLanguage, string>` ile derleme zamanında garanti edilir.
3. Prisma `Language` enum'u yeni değerleri bir migration ile alır: `ALTER TYPE ... ADD VALUE 'FR'|'NL'|'PL'`.
4. `targets` (MarketTarget) ve clinic API'lerindeki zod enum kopyaları kanonik listeyle senkron tutulur.
5. RTL yönlendirmesi merkezi `web/app/_lib/creative-lang.ts` → `rtlFor(code)` yardımcısına taşınır; RTL dilleri `RTL_LANGUAGES = {AR, HE, FA, UR}` listesiyle tanımlanır. Önizleme kartlarında (studio, library, test-detail) `dir` ve `.ad-art[dir="rtl"]` CSS kuralı uygulanır.
6. UI kabuğu RTL'e çevrilmez; yalnız kreatif kartı RTL gösterilir. UI dili hâlâ TR/EN'dir (spec §4).
7. Politika motoru (packages/policy) FR/NL/PL karşılığı olan guarantee / before-after / personal-attribute kalıplarıyla genişletilir.

## Sonuç
- `docs/meta-constraints.md`: Meta reklam kopyası dilleri sınırlı değildir; dil etiketi ve RTL kullanıcı adına ürün katmanında çözülür.
- Değişiklikler: llm'enum + LOCALIZATION, prisma enum + migration, clinic/targets API zod, studio/creative/planner UI, ai/chat dil haritası, policy regex + testler.
- Testler: `packages/llm` 3 yeni dil için prompt turu; `packages/policy` FR/NL/PL fixture'ları.