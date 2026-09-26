# 0010 — Haftalık E-posta Raporu (PDF + Resend)

- Tarih: 2026-09-26
- Durum: Kabul
- İlgili spec: 3.10

## Bağlam
3.10 haftalık PDF/e-posta raporu (P1) ister. Web'de iskelet JSON endpoint'i vardı (`api/reports/weekly`); PDF üreticisi ve e-posta altyapısı yoktu. Gönderim zamanlaması için meta-sync worker'ındaki zamanlayıcı (her 5 dk) kullanılabilir.

## Karar
1. **Yeni paket `@admedic/reporting`**: rapor sorgusu (`buildWeeklyReport`), pdfmake ile PDF (`renderReportPdf`), Resend ile e-posta (`sendWeeklyReportEmail`). Rohibi web route ve worker ortak kullanır.
2. **PDF üretimi: pdfmake 0.2** — Türkçe karakterler için dahili Roboto VFS fontu; `createPdf(doc).getBuffer()` ile Buffer döner.
3. **E-posta: Resend** — `RESEND_API_KEY` ve `RESEND_FROM` env; alıcı `WEEKLY_REPORT_RECIPIENT`.
4. **Zamanlama (worker)**: `WEEKLY_REPORT_DAY` (varsayılan 0/Pazar) gününde, `runScheduled` içinde `deliverWeeklyReport` çağrılır. Çöp kayıt önlemek için `ReportDelivery` tablosu (`@@unique([workspaceId, periodStart])`); gönderim hatası `error` alanında saklanır, e-posta tekrar denenmek zorunda değildir.
5. **İndirme**: `api/reports/weekly?pdf=1` → `application/pdf` + `content-disposition: attachment`. `respond` helper'ı yalnız JSON döner; route bu yüzden iki dala ayrıldı.
6. Ortam değişkenleri: `RESEND_API_KEY`, `RESEND_FROM` (varsayılan `Admedic <raporlar@admedic.io>`), `WEEKLY_REPORT_RECIPIENT` (email), `WEEKLY_REPORT_DAY` (0–6).

## Sonuç
- Alıcı per-workspace değil, ortam düzeyindedir (tenant bazlı alıcı, Organization'da e-posta alanı eklenirse gelecekte yapılabilir).
- `ReportDelivery` migration'ı `prisma migrate deploy` ile uygulanır.
- Testler: `packages/reporting` (dönem hesabı, PDF başlık/boş olmama). E-posta ağı çağrısı testlerde yapılmaz.
- Gönderim günü UTC'ye göre hesaplanır: `new Date().getUTCDay()` (`packages/reporting` `isReportDay`; `WEEKLY_REPORT_DAY` 0–6 UTC). Sunucunun yerel saat dilimi sonucu etkilemez.