# ADR-0012: Faturalandırma akışı — Stripe Checkout, webhook dedupe ve mock ödeme simülasyonu

- **Durum:** Kabul edildi
- **Tarih:** 2026-09-26
- **İlgili:** spec §3.12 (P2), §1 kapsam dışı "otomatik ödeme/tahsilat" (platform aboneliği reklam
  harcamasından bağımsızdır), ADR-0011 (minor unit)

## Bağlam

İlk faturalandırma iskeleti aboneliği ödeme tamamlanmadan `ACTIVE` yapıyor, Stripe webhook'unu imzasız
kabul ediyor, olay tekrarını ayırt etmiyor, `unpaid/incomplete` gibi durumları `ACTIVE`'e düşürüyor ve
dönem yedeğini `Date.now()*1000` ile hesaplıyordu. Plan fiyatları rotada sabitti. Şemada Stripe olay
tablosu ve `Invoice.stripeInvoiceId` sütunu yok.

## Karar

1. **Tek kaynak plan tablosu:** `packages/stripe/src/plans.ts` (`PLAN_TABLE`, `STRIPE_API_VERSION`,
   `planPriceId`). Fiyat kimlikleri `STRIPE_PRICE_STARTER/PROFESSIONAL/ENTERPRISE` ortamdan gelir; tutarlar
   yalnızca panel/taslak fatura gösterimi içindir, tahsilat tutarını Stripe Price belirler. Web bu dosyayı
   `web/app/api/billing/_lib/stripe.ts` üzerinden kullanır (paket bağımlılığı eklenene kadar göreli içe aktarma).
2. **Mod:** mock = `STRIPE_SECRET_KEY` yok **ve** `NODE_ENV !== "production"`. Production'da anahtar yoksa
   Stripe gerektiren işlemler 503 döner; hiçbir yol ödeme olmadan etkinleştirmez.
3. **Gerçek mod:** `POST /api/billing/stripe/checkout` (OWNER/ADMIN) Stripe Checkout oturumu açar ve
   `checkoutUrl` döner; yerel abonelik dokunulmaz. Etkinleştirme yalnızca `checkout.session.completed`
   (`payment_status=paid`) webhook'unda olur. `PATCH /api/billing/subscription` ve elle fatura ödeme 409 döner
   ("Stripe üzerinden"). Ücretsiz plana geçiş, Stripe ile yönetilen açık abonelik varken 409'dur (iptal
   önce Stripe'ta yapılır; müşteri portalı/iptal ucu kalan iştir).
4. **Mock mod (ödeme simülasyonu):** ücretli plan seçimi (checkout veya PATCH) aboneliği `PAST_DUE`
   ("ödeme bekleniyor") olarak kaydeder ve plan tablosundaki tutarla `DRAFT` fatura açar;
   `POST /api/billing/invoices { invoiceId, action: "mark-paid" }` (OWNER/ADMIN) faturayı `PAID` yapar ve
   aboneliği yeni dönemle `ACTIVE`'e alır. `FREE` her modda ödeme gerektirmez, hemen `ACTIVE`; açık taslaklar
   `VOID` olur. Tüm dallar audit'e yazılır (`PLAN_CHANGED`, `CHECKOUT_STARTED`, `INVOICE_PAID`).
5. **Webhook:** `stripe-signature` + `STRIPE_WEBHOOK_SECRET` ile doğrulama; başlık veya secret yoksa
   **401 fail-closed**. Tek istisna `META_MOCK_MODE=true` ve production dışı: imzasız gövde `{ mock: true }`
   ile kabul edilir ve loglanır. Gövde Zod ile doğrulanır (400).
6. **Dedupe:** olay tablosu olmadığı için işlenen her olay `AuditLog(action:"STRIPE_EVENT",
   entityId: event.id)` olarak yazılır; aynı `event.id` ikinci kez → 200 `{ duplicate: true }`. Eşzamanlı
   teslimatlar olay kimliği üzerinden `pg_advisory_xact_lock` ile sıraya alınır; olay işleme ve audit tek
   transaction'dadır. Tenant'a bağlanamayan olaylar 200 `{ ignored: true }` döner (sonsuz yeniden deneme
   önlenir); veritabanı hataları 503 ile Stripe'ın yeniden denemesine bırakılır.
7. **Durum eşlemesi:** `active/trialing → ACTIVE`, `past_due/unpaid/incomplete/paused → PAST_DUE`,
   `canceled → CANCELED`, `incomplete_expired → EXPIRED`, bilinmeyen → `PAST_DUE` (asla ACTIVE). Dönem
   `current_period_*` veya `items.data[0].current_period_*` (Basil+ API) alanlarından okunur; alan yoksa mevcut
   değer korunur. Ödenmiş fatura yalnızca `PAST_DUE/ACTIVE` aboneliği etkinleştirir; iptal edilmiş abonelik
   ödeme ile geri açılmaz.
8. **Fatura eşlemesi:** `Invoice.stripeInvoiceId` sütunu yok; Stripe fatura kimliği → yerel fatura eşlemesi
   `AuditLog(action:"STRIPE_INVOICE", entityId: <stripe invoice id>, after.invoiceId)` ile tutulur, aynı tutarlı
   açık taslak varsa o kapatılır, yoksa ödenmiş fatura oluşturulur.

## Sonuçlar

- Şema ihtiyacı (ayrı iş): `Invoice.stripeInvoiceId String? @unique` ve `StripeEvent(id, type, processedAt)`
  tablosu; eklendiğinde AuditLog tabanlı dedupe/eşleme bu sütunlara taşınır.
- `packages/stripe` `stripe` bağımlılığı v16'dır; API sürüm sabiti aynı olsa da bağımlılık ^22'ye
  yükseltilmeli ve `@admedic/config` bağımlılık olarak eklenmelidir (pnpm install gerektirir).
- Eski `web/app/api/billing/invoices/[id]/pay` rotası teslimat derinliği kısıtı nedeniyle değiştirilmedi;
  yerine `POST /api/billing/invoices` kullanılır ve eski rota kaldırılmalıdır.
- Testler: `web/tests/billing.integration.test.ts` (imzasız 401, mock izin, imza doğrulama, dedupe, durum
  eşlemesi, fatura olayları, roller, mock/gerçek mod kapıları).
