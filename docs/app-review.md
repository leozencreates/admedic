# Meta App Review başvuru hazırlığı

- İlgili: ADR-0023, `docs/meta-constraints.md` (2026-09-29 bölümü), `web/app/_lib/meta-scopes.ts`
- Durum: Taslak. Başvuru metinleri ürün sahibinin onayından sonra Meta Uygulama Paneline girilir.
- Son güncelleme: 2026-09-29

## Başvurudan önce (ürün sahibi)

1. **İşletme doğrulaması:** Uygulamanın bağlı olduğu Business Manager için Meta işletme doğrulaması. Gerekenler: şirket
   unvanı, adresi, vergi levhası ya da ticaret sicil belgesi, alan adı veya e-posta doğrulaması.
2. **Uygulama türü:** İşletme (Business) uygulaması. Uygulama, tek bir Business Manager altında olmalı. Hangi Business
   Manager kullanılacağı spec §8'de açık soru olarak duruyor.
3. **Gizlilik politikası adresi:** Herkese açık, HTTPS. Aydınlatma metni ve açık rıza metinleri ile uyumlu olmalı
   (ADR-0016).
4. **Test hesabı:** İnceleyicinin girebileceği bir panel hesabı. Rolü hesap sahibi, parolası güçlü; demo verisi olan
   ayrı bir çalışma alanında açılır. Giriş bilgileri başvuruya yazılır.
5. **Canlı sunucu:** İnceleyici gerçek adrese (`https://<alan adı>`) girer. `docs/runbook.md` tamamlanmış olmalı.

## İzinler ve kullanım açıklamaları

Her izin için Meta'ya iki şey verilir: yazılı açıklama (İngilizce) ve gerektiğinde ekran kaydı. Aşağıdaki metinler
taslaktır.

| İzin | Neden gerekli | Ekran kaydında gösterilecek |
|---|---|---|
| `ads_management` | Onaylanan kampanyayı, reklam setini, kreatifi ve reklamı Meta'ya kapalı (PAUSED) yüklemek; etkinleştirmek, duraklatmak, bütçe değiştirmek | Kampanya onayı → "Meta'ya yükle" → Ads Manager'da kapalı kampanya |
| `ads_read` | Kampanya performansını (harcama, lead, CPL) ve reklam inceleme durumunu okumak | Kampanya sayfası → Performans sekmesi |
| `business_management` | Kullanıcının Business Manager'ındaki reklam hesaplarını ve sayfaları listelemek | Meta ile bağlan → hesap ve sayfa seçimi |
| `pages_show_list` | Reklamın yayınlanacağı Facebook sayfasını seçtirmek | Meta bağlantıları → sayfa listesi |
| `leads_retrieval` | Anında Form'dan gelen lead'in yanıtlarını webhook bildirimi üzerine çekmek | Test lead'i gönder → Lead'ler gelen kutusunda görünmesi |
| `pages_manage_ads` | Anında Form (lead formu) oluşturmak ve sayfa anahtarıyla lead okumak | Kampanya yükleme sırasında form oluşumu |
| `pages_manage_metadata` | Sayfayı uygulamanın webhook'una abone etmek (`leadgen`, `messages`) | Bağlantı sonrası aboneliğin etkinleşmesi |
| `pages_messaging` | Messenger'dan gelen hasta adayı mesajlarına yanıt vermek | Messenger'dan mesaj → panelde görünüp yanıtlanması |
| `instagram_basic`, `instagram_manage_messages` | Instagram DM'lerini gelen kutusuna almak ve yanıtlamak | Instagram DM → panelde görünüp yanıtlanması |
| `whatsapp_business_messaging` | WhatsApp'tan gelen mesajlara yanıt ve onaylı şablonla karşılama göndermek | Panelden mesaj gönderme → telefonda alındığı (ayrı kayıt zorunlu) |
| `whatsapp_business_management` | İşletme numarasını ve şablonları okumak | Şablon oluşturma (ayrı kayıt zorunlu) |

**Başvurulmaması önerilenler:** Pilotta Instagram ve Messenger kullanılmayacaksa bu izinler başvurudan çıkarılır. Her
izin ayrı inceleme yükü ve ayrı red riski getirir.

## Ekran kaydı senaryosu (tek oturum, sırayla)

1. **Giriş:** `https://<alan adı>/login` → test hesabıyla giriş.
2. **Bağlantı:** Meta bağlantıları → "Meta ile bağlantı kur" → Meta izin penceresi (izin adları görünsün) → dönüş,
   reklam hesabı ve sayfa listesi.
3. **Kampanya:**
   - Yeni kampanya → pazar ve bütçe → taslak.
   - Onaya gönder → hesap sahibi onayı → "Meta'ya yükle".
   - Ads Manager'da kampanyanın kapalı (Paused) durumda göründüğü sekme.
4. **Lead:** Meta Lead Ads Test Aracı (developers.facebook.com/tools/lead-ads-testing) ile test lead'i →
   panelde Lead'ler gelen kutusunda lead'in yanıtlarıyla görünmesi.
5. **WhatsApp** (izin isteniyorsa ayrı kayıtlar):
   - Telefondan işletme numarasına mesaj → panelde görünmesi → panelden yanıt → telefonda alındığı.
   - Şablon oluşturma kaydı ayrıca çekilir.
6. **Performans:** Kampanya sayfası → Performans sekmesi (okuma izni).

Kayıtta ekran çözünürlüğü okunur olmalı, tarayıcı adres çubuğu görünmeli. Kayıt İngilizce arayüzle çekilirse
inceleme kolaylaşır. Arayüzün İngilizcesi şu an yalnızca menü ve başlıklarda var (remaining-work §11).

## Erişim düzeyi

- Marketing API erişim düzeyi 2026-05-04'ten beri "Limited Access" / "Full Access" adını taşıyor
  (`docs/meta-constraints.md`).
- Pilot Limited Access ile başlar. Full Access'e başvuru koşulu: son 15 günde 500+ çağrı ve hata oranının %15'in altında
  olması.

## Açık sorular (ürün sahibi)

- Uygulama hangi Business Manager altında olacak? (spec §8)
- Pilotta hangi kanallar açık: yalnızca Anında Form + WhatsApp mı, Messenger ve Instagram da mı?
- Gizlilik politikası adresi ve metni hazır mı? (hukuki onay, ADR-0016 §4)
