# 0015 — Instant Form rızası, bekleyen lead çekimi, reklam düzeyinde Meta incelemesi ve appsecret_proof

- Tarih: 2026-09-27
- Durum: Kabul
- İlgili spec: 3.1, 3.5, 3.7, 3.11
- Önceki kararlar: ADR-0006 (lead gizliliği), ADR-0013 (lead asistanı), ADR-0014 (tam PAUSED yayın)

## Bağlam
Canlıya geçişi engelleyen dört açık vardı:
1. **Rıza lead'den alınmıyordu.** Admedic'in kurduğu Instant Form'larda zorunlu rıza kutusu (`kvkk_consent`) var, ama
   lead çekimi kutu yanıtını (`custom_disclaimer_responses`, `field_data`'da DEĞİL) istemiyor ve `ConsentRecord`
   yazmıyordu. Spec 3.11: "rıza kaydı saklanır".
2. **Alanları çekilemeyen lead kalıcı olarak boş kalıyordu.** Webhook anında sayfa token'ı yoksa/geçersizse ya da
   `leads_retrieval` izni eksikse lead yalnızca kimlikle (`metadata.pendingFetch`) yazılıyor, yeniden deneme yoktu.
3. **Meta incelemesi yanlış düzeyde okunuyordu.** `createCampaign` oluşturmadan sonra kampanya düğümünde
   `review_feedback` okuyordu; kampanya nesnesinde bu alan yoktur (Meta #100) → canlıda okuma hatası, Meta'da oluşmuş
   kampanyanın kimliğini kaybettirip yeniden denemede **yinelenen kampanya** üretirdi. `review-sync` de kampanya
   kimliğini reklam ucuna veriyordu. Reddedilen reklam için uyarı yoktu.
4. **`appsecret_proof` yalnızca `/me/*` çağrılarındaydı.** Uygulamada "Require App Secret" açıkken Marketing API,
   Lead Ads, CAPI ve Send API çağrıları reddedilirdi.

## Karar

### 1. Instant Form rızası → ConsentRecord
- Yayında her lead formu için `LeadForm` satırı yazılır: Meta form kimliği, dil, sayfa, rıza kutusu anahtarı ve
  **kişinin gördüğü metnin değişmez kopyası** (başlık + gövde + kutu metni + gizlilik bağlantısı).
- Lead çekimi `custom_disclaimer_responses` alanını ister. Gelen lead'in formu Admedic'inse (aynı kuruluş) tek bir
  `ConsentRecord` yazılır: tür **DATA_PROCESSING**, `source=INSTANT_FORM`, `evidence` (form, kutu, dayanak, Meta yanıtı,
  leadgen kimliği; PII yok), `acceptedAt` = Meta `created_time`.
  - Dayanak `CHECKBOX_RESPONSE`: Meta kutu yanıtı (işaretli → GRANTED, işaretsiz → DENIED).
  - Dayanak `REQUIRED_CHECKBOX`: yanıt yoksa (webhook içi veri, çekilemeyen lead) zorunlu kutu formun gönderilebilmesinin
    ön koşulu olduğundan GRANTED.
- Kutu metni "talebe yanıt ve iletişim için veri işleme" onayıdır; **pazarlama/ölçüm (CAPI) rızası değildir**:
  `Lead.consentGiven` ve CAPI kapısı değişmez. Ads Manager'da kurulmuş formlarda metin bilinmediği için kayıt yazılmaz
  (ham yanıtlar lead metadata'sında). Anonimleştirme `evidence`'ı siler; veri sahibi dışa aktarımı kaynak ve dayanağı içerir.

### 2. Bekleyen lead çekimi
`refetchPendingLeads` (`web/app/_lib/lead-refetch.ts`) bekleyen lead'i sayfa token'ıyla yeniden çeker; başarılıysa
alanları, dili, ülkeyi, tekrar (duplicate) işaretini, rıza kaydını ve (telefon geldiyse) WhatsApp konuşmasını yazar,
karşılamayı başlatır; `LEAD_FETCH_RECOVERED` denetimi düşülür. Tetikleyiciler: OAuth dönüşü (sayfa token'ları
yenilenince), aynı kuruluşa sorunsuz çekilen yeni lead webhook'u (yanıttan sonra, Next `after`) ve panel
(`POST /api/leads/refetch`, tek lead ya da hepsi). Otomatik denemeler arasında 10 dk beklenir; 90 günden eski lead
denenmez (Meta saklama süresi — DOĞRULANMADI).

### 3. Reklam düzeyinde Meta incelemesi
- Kampanya oluşturma sonrası okuma kaldırıldı (P0 hata düzeltmesi).
- `getAdReviews`: reklamlar çoklu kimlik okumasıyla (`?ids=`, 50'lik) `effective_status`, `ad_review_feedback`,
  `issues_info` ile okunur; silinmiş kimlik (#100) tüm isteği bozarsa parça tek tek okunur.
- `applyAdReviewSync` (`@admedic/database`, web ve worker ortak): reklam alanları (`metaEffectiveStatus`,
  `metaReviewFeedback`, `metaReviewCheckedAt`), kampanya toplam durumu (DISAPPROVED > WITH_ISSUES > PENDING_REVIEW >
  NO_ISSUES) ve sorunlu reklamların gerekçeleri yazılır; yeni red → **AD_DISAPPROVED** (CRITICAL) uyarısı +
  `META_AD_DISAPPROVED` denetim kaydı (append-only gerekçe geçmişi), red kalkınca açık uyarı çözülür. Kampanya başına
  danışma kilidi eşzamanlı senkronda uyarının çoğalmasını engeller.
- Worker: ACTIVE kampanyalar 15 dk, PUBLISHED_PAUSED 6 saatte bir (tur başına 20 kampanya). Panel: "İncelemeyi yenile".

### 4. appsecret_proof
`appsecret_proof` (HMAC-SHA256; anahtar app secret, veri access token, hex) artık Marketing istemcisinin tüm GET/POST çağrılarında, Lead Ads, CAPI,
Messenger/Instagram Send API ve bağlantı token'ıyla WhatsApp gönderiminde. Kanıt her zaman çağrıdaki token'dan
hesaplanır. Ortam düzeyi `WHATSAPP_TOKEN` başka bir uygulamaya ait olabileceğinden kanıtsız kalır (yanlış kanıt çağrıyı
reddettirir). Sayfalamada `paging.next` yalnızca Graph kökündeyse izlenir; kanıt bağlantıda yoksa taşınır.

## Sonuç
- Migration `20260927150000_lead_consent_and_ad_review`: `LeadForm` tablosu, `ConsentRecord.source/evidence`,
  `Ad.metaEffectiveStatus/metaReviewFeedback/metaReviewCheckedAt`, `Campaign.metaReviewCheckedAt`, `AlertType.AD_DISAPPROVED`.
- `Campaign.metaReviewStatus` değerleri: DISAPPROVED / WITH_ISSUES / PENDING_REVIEW / NO_ISSUES / UNKNOWN.
- Canlı doğrulama bekleyenler ve kaynaklar: `docs/meta-constraints.md` (2026-09-27).
- Testler: `packages/meta-api/src/secret-proof.test.ts`, `review.test.ts`, `leadgen.test.ts`, `client.test.ts`;
  `web/tests/lead-consent-review.integration.test.ts`, `publish-flow.integration.test.ts`;
  `workers/meta-sync/src/scheduler.db.test.ts`.
