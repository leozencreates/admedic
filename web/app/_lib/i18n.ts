/**
 * UI dili (spec §4: arayüz dilleri TR ve EN; kreatif dilleri ayrıdır — ADR-0009 §6).
 * Bu modül saf tutulur (tarayıcı/Next API'si yok) ki hem sunucu bileşenleri/route handler'ları
 * hem istemci bileşenleri kullanabilsin. Dil kaynağı `ui-lang` çerezidir (tr|en, varsayılan tr);
 * sunucu çerezi okuyup `<html lang>` ve etiketleri üretir, `LanguageSwitcher` çerezi yazıp
 * `router.refresh()` çağırır. Render sırasında localStorage okunmaz (hydration uyumsuzluğu).
 * Uygulama adı sözlükte değildir; `loadEnv().APP_NAME`'den gelir.
 */
export const SUPPORTED_LANGUAGES = ["tr", "en"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "tr";
export const UI_LANG_COOKIE = "ui-lang";
/** Çerez ömrü: 1 yıl. */
export const UI_LANG_MAX_AGE = 60 * 60 * 24 * 365;
export const LANGUAGE_LABEL: Record<Language, string> = { tr: "TR", en: "EN" };

const tr = {
  "lang.label": "Dil",
  "layout.description": "Meta reklam optimizasyon paneli",
  "layout.tagline": "Reklam ve büyüme stüdyosu",
  "layout.metaGraph": "Meta Graph",
  "layout.mode": "Mod",
  "layout.modeMock": "Deneme (Meta'ya bağlanmaz)",
  "layout.modeLive": "Canlı",
  "layout.envDemo": "Demo ortamı",
  "layout.envLive": "Canlı veri ortamı",
  "layout.skip": "İçeriğe atla",
  "layout.mainNav": "Ana menü",
  "layout.menu": "Menü",
  "layout.tabNav": "Hızlı erişim",
  "nav.policies": "Politika ve bütçe koruma",
  "new.ad": "Reklam",
  "new.adHint": "Reklam metni ve görsel taslağı",
  "new.campaign": "Kampanya",
  "new.campaignHint": "Planla, onaya gönder, Meta'ya yükle",
  "new.test": "A/B testi",
  "new.testHint": "İki reklamın sonuçlarını karşılaştır",
  "group.ads": "Reklamlar",
  "group.tests": "Testler",
  "group.campaigns": "Kampanyalar",
  "group.performance": "Performans",
  "group.settings": "Ayarlar",
  "shell.search": "Ara",
  "shell.searchPlaceholder": "Lead ara: ad, e-posta veya telefon",
  "shell.searchOpen": "Aramayı aç",
  "shell.new": "Yeni",
  "shell.newMenu": "Yeni oluştur",
  "shell.notifications": "Bildirimler",
  "shell.notificationsEmpty": "Açık uyarı yok.",
  "shell.notificationsAll": "Tüm uyarıları gör",
  "shell.account": "Hesap menüsü",
  "shell.pendingBadge": "bekleyen",
  "shell.leadsBadge": "yanıt bekliyor",
  "shell.alertsBadge": "açık uyarı",
  "title.studio": "Reklam oluştur",
  "title.leadDetail": "Lead ayrıntısı",
  "title.testDetail": "Test ayrıntısı",
  "nav.overview": "Bugün",
  "nav.studio": "Reklam oluştur",
  "tab.studio": "Oluştur",
  "nav.library": "Reklam kütüphanesi",
  "nav.creative": "Çok dilli üretim",
  "nav.tests": "A/B testleri",
  "nav.experiments": "Test hesaplayıcı",
  "nav.campaigns": "Kampanyalar",
  "nav.campaignPlanner": "Yeni kampanya",
  "nav.approvals": "Onaylar",
  "nav.platforms": "Platformlar",
  "nav.metaConnections": "Meta bağlantıları",
  "nav.recommendations": "Öneriler",
  "nav.decisions": "Ajan kararları",
  "nav.leadTeam": "Lead takımı",
  "nav.insights": "İçgörüler",
  "nav.policyRules": "İçerik kuralları",
  "nav.clinic": "Klinik ve marka",
  "nav.leads": "Lead'ler",
  "nav.billing": "Faturalar",
  "nav.goLive": "Canlıya geçiş",
  "nav.alerts": "Uyarılar",
  "account.logout": "Oturumu kapat",
  "account.logoutError": "Çıkış yapılamadı. Tekrar deneyin.",
  "login.lead": "Reklamlarınızı, ekibinizin onaylarını ve deney sonuçlarını tek yerde yönetin.",
  "login.heading": "Oturum açın",
  "login.email": "E-posta",
  "login.password": "Parola",
  "login.submit": "Giriş yap",
  "login.submitting": "Giriş yapılıyor…",
  "login.failed": "Oturum açılamadı. E-posta ve parolayı kontrol edip tekrar deneyin.",
  "login.firstSetupSummary": "İlk kurulumu mu yapıyorsunuz?",
  "login.firstSetupBefore": "Sunucuda BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD ve BOOTSTRAP_CLINIC ortam değişkenlerini ayarlayıp",
  "login.firstSetupAfter": "çalıştırın; ardından bu e-posta ve parolayla giriş yapın. Kurulum adımları: docs/ad-studio.md.",
  "assistant.name": "{name} sesli asistan",
  "assistant.actionStart": "Başlatmak için basın (Ctrl+Shift+Boşluk).",
  "assistant.actionStop": "Durdurmak için basın (Esc).",
  "assistant.state.idle": "Hazır",
  "assistant.state.consent": "İzin isteniyor",
  "assistant.state.connecting": "Bağlanıyor…",
  "assistant.state.listening": "Dinliyorum…",
  "assistant.state.thinking": "Düşünüyor…",
  "assistant.state.speaking": "Konuşuyor…",
  "assistant.state.error": "Hata",
  "assistant.state.disabled": "Devre dışı",
  "assistant.end": "Asistanı kapat",
  "assistant.retry": "Tekrar dene",
  "assistant.transcript": "Konuşma",
  "assistant.you": "Siz",
  "assistant.hint": "Konuşun ya da yazın. Örneğin: \"kampanyaları göster\", \"onaylara git\".",
  "assistant.inputLabel": "Asistana yazın",
  "assistant.inputPlaceholder": "Bir komut yazın",
  "assistant.send": "Gönder",
  "assistant.ended": "Sesli asistan kapandı.",
  "assistant.notice.mock": "Deneme modu: asistan yazılı komutlarla çalışır, ses kullanılmaz.",
  "assistant.notice.textOnly": "Mikrofon kullanılamıyor ya da izin verilmedi; yazarak devam edebilirsiniz.",
  "assistant.consent.title": "Sesli asistan hakkında",
  "assistant.consent.intro": "{name} yapay zekâ destekli bir sesli asistandır. Başlatmadan önce lütfen okuyun.",
  "assistant.consent.processing": "Sesiniz ve yazdıklarınız yapay zekâ tarafından ve üçüncü taraf ElevenLabs'te işlenir.",
  "assistant.consent.storage": "Panel ses ve konuşma metnini saklamaz; yalnızca hangi işlemin yapıldığı denetim kaydına yazılır.",
  "assistant.consent.pii": "Hasta adı, telefon, e-posta ya da sağlık bilgisi söylemeyin. Asistan bu bilgileri okumaz.",
  "assistant.consent.limits": "Mikrofon yalnızca siz başlattığınızda açılır. Onay, harcama ve silme işlemleri sesle yapılmaz.",
  "assistant.consent.accept": "Kabul ediyorum, başlat",
  "assistant.consent.cancel": "Vazgeç",
  "assistant.error.start": "Sesli asistan başlatılamadı. Tekrar deneyin.",
  "assistant.error.connection": "Sesli asistan bağlantısı koptu.",
  "assistant.error.rateLimited": "Çok fazla oturum açıldı. Biraz sonra tekrar deneyin.",
  "assistant.error.unauthorized": "Oturumunuz kapanmış. Yeniden giriş yapın.",
  "assistant.error.forbidden": "Sesli asistanı kullanma yetkiniz yok.",
  "assistant.error.unreachable": "Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.",
  "assistant.error.disabled": "Sesli asistan bu kurulumda devre dışı.",
  "lead.status.new": "Yeni",
  "lead.status.contacted": "Görüşülüyor",
  "lead.status.qualified": "Nitelikli",
  "lead.status.consultation_booked": "Konsültasyon planlandı",
  "lead.status.travel_planned": "Seyahat planlandı",
  "lead.status.treated": "Tedavi tamamlandı",
  "lead.status.lost": "Kaybedildi",
} as const;

export type TranslationKey = keyof typeof tr;

/** `Record<TranslationKey, string>` tipi EN sözlüğünün eksiksiz olmasını derleme zamanında zorlar. */
const en: Record<TranslationKey, string> = {
  "lang.label": "Language",
  "layout.description": "Meta ads optimization panel",
  "layout.tagline": "Ads and growth studio",
  "layout.metaGraph": "Meta Graph",
  "layout.mode": "Mode",
  "layout.modeMock": "Test (not connected to Meta)",
  "layout.modeLive": "Live",
  "layout.envDemo": "Demo environment",
  "layout.envLive": "Live data environment",
  "layout.skip": "Skip to content",
  "layout.mainNav": "Main navigation",
  "layout.menu": "Menu",
  "layout.tabNav": "Quick access",
  "nav.policies": "Policies and budget guards",
  "new.ad": "Ad",
  "new.adHint": "Ad copy and image draft",
  "new.campaign": "Campaign",
  "new.campaignHint": "Plan, submit for approval, upload to Meta",
  "new.test": "A/B test",
  "new.testHint": "Compare the results of two ads",
  "group.ads": "Ads",
  "group.tests": "Tests",
  "group.campaigns": "Campaigns",
  "group.performance": "Performance",
  "group.settings": "Settings",
  "shell.search": "Search",
  "shell.searchPlaceholder": "Search leads: name, email or phone",
  "shell.searchOpen": "Open search",
  "shell.new": "New",
  "shell.newMenu": "Create new",
  "shell.notifications": "Notifications",
  "shell.notificationsEmpty": "No open alerts.",
  "shell.notificationsAll": "See all alerts",
  "shell.account": "Account menu",
  "shell.pendingBadge": "pending",
  "shell.leadsBadge": "awaiting reply",
  "shell.alertsBadge": "open alerts",
  "title.studio": "Create ad",
  "title.leadDetail": "Lead details",
  "title.testDetail": "Test details",
  "nav.overview": "Today",
  "nav.studio": "Create ad",
  "tab.studio": "Create",
  "nav.library": "Ad library",
  "nav.creative": "Multilingual generation",
  "nav.tests": "A/B tests",
  "nav.experiments": "Test calculator",
  "nav.campaigns": "Campaigns",
  "nav.campaignPlanner": "New campaign",
  "nav.approvals": "Approvals",
  "nav.platforms": "Platforms",
  "nav.metaConnections": "Meta connections",
  "nav.recommendations": "Recommendations",
  "nav.decisions": "Agent decisions",
  "nav.leadTeam": "Lead team",
  "nav.insights": "Insights",
  "nav.policyRules": "Content rules",
  "nav.clinic": "Clinic and brand",
  "nav.leads": "Leads",
  "nav.billing": "Billing",
  "nav.goLive": "Go-live check",
  "nav.alerts": "Alerts",
  "account.logout": "Sign out",
  "account.logoutError": "Could not sign out. Please try again.",
  "login.lead": "Manage your ads, your team's approvals and experiment results in one place.",
  "login.heading": "Sign in",
  "login.email": "Email",
  "login.password": "Password",
  "login.submit": "Sign in",
  "login.submitting": "Signing in…",
  "login.failed": "Could not sign in. Check your email and password, then try again.",
  "login.firstSetupSummary": "Setting up for the first time?",
  "login.firstSetupBefore": "Set BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD and BOOTSTRAP_CLINIC on the server, then run",
  "login.firstSetupAfter": "Then sign in with that email and password. Setup steps: docs/ad-studio.md.",
  "assistant.name": "{name} voice assistant",
  "assistant.actionStart": "Press to start (Ctrl+Shift+Space).",
  "assistant.actionStop": "Press to stop (Esc).",
  "assistant.state.idle": "Ready",
  "assistant.state.consent": "Asking for permission",
  "assistant.state.connecting": "Connecting…",
  "assistant.state.listening": "Listening…",
  "assistant.state.thinking": "Thinking…",
  "assistant.state.speaking": "Speaking…",
  "assistant.state.error": "Error",
  "assistant.state.disabled": "Disabled",
  "assistant.end": "Close assistant",
  "assistant.retry": "Try again",
  "assistant.transcript": "Conversation",
  "assistant.you": "You",
  "assistant.hint": "Speak or type. For example: \"show campaigns\", \"go to approvals\".",
  "assistant.inputLabel": "Type to the assistant",
  "assistant.inputPlaceholder": "Type a command",
  "assistant.send": "Send",
  "assistant.ended": "Voice assistant closed.",
  "assistant.notice.mock": "Test mode: the assistant works with typed commands, no audio.",
  "assistant.notice.textOnly": "The microphone is unavailable or permission was denied; you can continue by typing.",
  "assistant.consent.title": "About the voice assistant",
  "assistant.consent.intro": "{name} is an AI-powered voice assistant. Please read this before you start.",
  "assistant.consent.processing": "Your voice and what you type are processed by AI at the third-party provider ElevenLabs.",
  "assistant.consent.storage": "The panel does not store audio or transcripts; only which action was taken is written to the audit log.",
  "assistant.consent.pii": "Do not say patient names, phone numbers, emails or health details. The assistant does not read them.",
  "assistant.consent.limits": "The microphone only opens when you start it. Approvals, spending and deletions are not done by voice.",
  "assistant.consent.accept": "I agree, start",
  "assistant.consent.cancel": "Cancel",
  "assistant.error.start": "Could not start the voice assistant. Please try again.",
  "assistant.error.connection": "The voice assistant connection was lost.",
  "assistant.error.rateLimited": "Too many sessions were started. Please try again shortly.",
  "assistant.error.unauthorized": "Your session has ended. Please sign in again.",
  "assistant.error.forbidden": "You are not allowed to use the voice assistant.",
  "assistant.error.unreachable": "Could not reach the server. Check your connection and try again.",
  "assistant.error.disabled": "The voice assistant is disabled on this installation.",
  "lead.status.new": "New",
  "lead.status.contacted": "In conversation",
  "lead.status.qualified": "Qualified",
  "lead.status.consultation_booked": "Consultation booked",
  "lead.status.travel_planned": "Travel planned",
  "lead.status.treated": "Treatment completed",
  "lead.status.lost": "Lost",
};

export const dictionaries: Record<Language, Record<TranslationKey, string>> = { tr, en };

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** Çerez/sorgu değerini dile çevirir; bilinmeyen veya boş değer varsayılan dile düşer. */
export function parseLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}

/** `Cookie` başlığından (veya `document.cookie`) `ui-lang` değerini çözer. */
export function languageFromCookieHeader(cookieHeader: string | null | undefined): Language {
  if (!cookieHeader) return DEFAULT_LANGUAGE;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === UI_LANG_COOKIE) return parseLanguage(decodeURIComponent(rest.join("=")));
  }
  return DEFAULT_LANGUAGE;
}

/** Sunucu ve istemcide kullanılabilir çeviri; anahtar yoksa varsayılan dile, o da yoksa anahtara düşer. */
export function t(key: TranslationKey | (string & {}), lang: Language = DEFAULT_LANGUAGE): string {
  const dict = dictionaries[lang] ?? dictionaries[DEFAULT_LANGUAGE];
  const k = key as TranslationKey;
  return dict[k] ?? dictionaries[DEFAULT_LANGUAGE][k] ?? key;
}

export function formatLeadStatus(status: string, lang: Language = DEFAULT_LANGUAGE): string {
  return t(`lead.status.${status.toLowerCase()}`, lang);
}

// Menü ağacı, rol görünürlüğü ve sayfa → grup eşlemesi: `nav-tree.ts` (ADR-0017).
