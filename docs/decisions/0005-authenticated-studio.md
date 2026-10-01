# ADR 0005 — Oturumlu reklam kütüphanesi

2026-09-20 — Kabul edildi (kullanıcının ikinci geliştirme fazı onayı).

- Next.js route handlers, web için oturumlu BFF olur. Fastify'ın mevcut salt okunur API'sinden bağımsızdır.
- Rastgele oturum belirteçleri yalnızca HttpOnly/SameSite cookie'de; SHA-256 özeti, kullanıcı, çalışma alanı ve süre PostgreSQL'de saklanır. Her erişimde aktif üyelik yeniden doğrulanır. Yazmalarda origin kontrolü ve rol kontrolü zorunludur.
- İlk kullanıcı sunucu CLI'ı ile oluşturulur. Genel kayıt veya demo kullanıcısına otomatik giriş yoktur. Parolalar scrypt ile saklanır.
- StudioDraft ve StudioExperiment modelleri mevcut ROAS/purchase deneylerinden ayrıdır: lead sayılarını purchase alanına yazmak yanlış analiz üretir. Deneyler onaylanmış içeriğin değişmez kopyasını saklar. Kayıt ve durum değişiklikleri optimistic version kontrolü + audit işlemiyle tek transaction'da yapılır.
- DRAFT/REJECTED → IN_REVIEW → APPROVED/REJECTED. Owner veya admin içerik onaylar. Her düzenleme durumu DRAFT'a döndürür. Yüksek risk engellenir. Onay, Meta yayını veya bütçe harcaması değildir.
- LLM sağlayıcısı `packages/llm` arkasındadır; anahtar/model ortamdan gelir. Başarısız çağrı şablona sessizce dönmez. Loglarda yalnızca tenant, model, prompt sürümü, token, süre ve durum vardır.
- İlk deterministik içerik kural seti `packages/policy` içinde sürümlüdür. Düşük risk Meta onay garantisi değildir; LLM politika denetimi ve veritabanından yönetilen kurallar bu fazın dışında kalır.
- Kaynak: Anthropic Messages API resmi dokümanı, 2026-09-20: https://platform.claude.com/docs/en/api/messages/create
