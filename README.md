# Admedic — Sağlık Turizmi Meta Ads Agent

Klinik/hastaneler için iki modüllü web uygulaması:

1. **A/B Test + Bütçe Agent'ı** — Meta reklam kampanyalarında varyantları (ad set) ROAS'a göre istatistiksel olarak karşılaştırır ve bütçeyi kazanan varyanta kademeli olarak kaydırır.
2. **WhatsApp Lead Takip Agent'ı** — Meta lead'lerine karşılama mesajı, günlük hatırlatma ve kliniğin fotoğraf/videolarını gönderir.

Tüm agent kararları **kural tabanlı** (deterministik) — ücretsiz çalışır, LLM gerektirmez.

## Teknolojiler
- Next.js 16 (App Router) + TypeScript + Tailwind
- Prisma + SQLite (geliştirme)
- Meta Marketing API (OAuth + Insights)
- WhatsApp Business Cloud API (veya Mock modu)

## Kurulum

```bash
npm install
npm run db:reset -- --force   # şemayı uygular
npm run seed                  # demo veri
npm run dev                   # http://localhost:3000
```

### Ortam değişkenleri (`.env`)
```
DATABASE_URL="file:./dev.db"
# Meta Ads (isteğe bağlı, olmadan demo modunda çalışır)
META_APP_ID=""
META_APP_SECRET=""
META_REDIRECT_URI="http://localhost:3000/api/meta/callback"
# WhatsApp (isteğe bağlı, yoksa Mock modu)
WHATSAPP_TOKEN=""
```

## Nasıl çalışır?

### A/B Test Agent'ı
1. `/api/meta/connect` ile Meta reklam hesabını bağla → `/api/meta/sync` ile kampanyaları çek.
2. `Testler → Yeni A/B Testi`: kampanya seç, varyantlar eşit bütçeyle başlar.
3. `Agent'ı Çalıştır` (veya cron): motor günlük metrikleri bootstrap (sabit tohumlu) ile karşılaştırır:
   - **Faz 1 — Veri toplama:** varyantlar minimum harcama/dönüşüm eşiğine ulaşana dek eşit bütçe.
   - **Faz 2 — Karar:** `P(kazanan > ikinci) >= 0.95` ve ROAS farkı ≥ %5 olunca kazananı seçer, bütçenin %90'ı kazanana gider.
   - **Faz 3 — Keşif:** belirsizlikte bütçenin %15–30'unu kademeli kaydırır.
   - Güvenlik sınırları: varyant başına minimum bütçe, kaydırma miktarı sınırı.
   - Tüm kararlar `AgentAction` günlüğüne yazılır.

### WhatsApp Lead Takip
1. `/whatsapp` sayfasından sağlayıcıyı seç: **Mock** (güvenli simülasyon) veya **Meta Cloud API**.
2. `Leadler → Yeni Lead`: lead eklendiğinde agent plan kurar:
   - **Karşılama** (anında) + klinik medyası
   - **Takip** (varsayılan 24 saat sonra)
   - **Günlük hatırlatma** (ayarlanabilir saat, cevap almazsa)
   - **Geri kazanma** (14 gün yanıt yoksa son mesaj, ardından LOST)
3. `Şimdi Gönder` / `Önizle (dry-run)` ile el ile çalıştır. Canlı için cron servisine bağla:

```bash
# 5 dakikada bir (crontab)
*/5 * * * * curl -s -X POST http://localhost:3000/api/agent/followups -H "Content-Type: application/json" -d '{}'
```

## API Özeti
| Metot | Uç | Açıklama |
|---|---|---|
| GET | `/api/dashboard` | Genel özet |
| GET/POST | `/api/tests` | Test listesi / oluşturma |
| POST | `/api/tests/[id]/run` | Agent döngüsü (`pushToMeta` ile canlı bütçe) |
| POST | `/api/tests/[id]/metrics` yerine GET | Günlük metrikler |
| POST | `/api/leads` / `[id]` / `[id]/messages` | Lead yönetimi + manuel gönderim |
| POST | `/api/agent/followups` | Lead takip planı + gönderim (cron) |
| GET/POST | `/api/media` | Medya yükleme/listeleme |
| GET/POST | `/api/whatsapp` | WhatsApp yapılandırması |
| GET | `/api/meta/connect` `/api/meta/callback` | Meta OAuth |
| POST | `/api/meta/sync` | Kampanya + insight senkronizasyonu |

## Not
- Veriler `prisma/dev.db` (SQLite) içinde durur. `npm run seed` sıfırlar ve demo senaryo yükler.
- WhatsApp **Mock** modunda hiçbir gerçek mesaj gönderilmez; gönderimler loglanır.
- Meta/WhatsApp canlı modu için Meta Business'te kurulan uygulama ve API erişimi gerekir (ads_management, ads_read, whatsapp_business_messaging).