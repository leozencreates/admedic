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
  "layout.panel": "Panel",
  "layout.description": "Meta reklam optimizasyon paneli",
  "layout.tagline": "Reklam ve büyüme stüdyosu",
  "layout.metaGraph": "Meta Graph",
  "layout.mode": "Mod",
  "layout.modeMock": "MOCK",
  "layout.modeLive": "CANLI",
  "layout.breadcrumb": "Çalışma alanı / Klinik reklam yönetimi",
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
  "shell.workspace": "Çalışma alanı",
  "shell.role": "Rol",
  "title.studio": "Reklam oluştur",
  "title.leadDetail": "Lead ayrıntısı",
  "title.testDetail": "Test ayrıntısı",
  "nav.overview": "Bugün",
  "nav.studio": "Reklam oluştur",
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
  "nav.insights": "İçgörüler",
  "nav.policyRules": "İçerik kuralları",
  "nav.clinic": "Klinik ve marka",
  "nav.leads": "Lead'ler",
  "nav.billing": "Faturalar",
  "nav.alerts": "Uyarılar",
  "account.logout": "Oturumu kapat",
  "account.login": "Oturum aç",
  "account.logoutError": "Çıkış yapılamadı. Tekrar deneyin.",
  "login.lead": "Reklamlarınızı, ekibinizin onaylarını ve deney sonuçlarını tek yerde yönetin.",
  "login.heading": "Oturum açın",
  "login.email": "E-posta",
  "login.password": "Parola",
  "login.workspace": "Çalışma alanı kimliği",
  "login.submit": "Çalışma alanına gir",
  "login.submitting": "Giriş yapılıyor…",
  "login.failed": "Oturum açılamadı. E-posta, parola ve çalışma alanı kimliğini kontrol edip tekrar deneyin.",
  "login.firstSetupSummary": "İlk kurulumu mu yapıyorsunuz?",
  "login.firstSetupBefore": "Sunucuda BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD ve BOOTSTRAP_CLINIC ortam değişkenlerini ayarlayıp",
  "login.firstSetupAfter": "çalıştırın. Komut çalışma alanı kimliğini verir. Kurulum adımları: docs/ad-studio.md.",
  "lead.new": "Yeni Lead",
  "lead.status.new": "Yanıt bekliyor",
  "lead.status.contacted": "Görüşülüyor",
  "lead.status.qualified": "Nitelikli",
  "lead.status.consultation_booked": "Konsültasyon planlandı",
  "lead.status.travel_planned": "Seyahat planlandı",
  "lead.status.treated": "Tedavi tamamlandı",
  "lead.status.lost": "Kaybedildi",
  "lead.consent.grant": "Açık rızayı kaydet",
  "lead.consent.granted": "Kayıtlı",
  "lead.consent.pending": "Beklemede",
  "consent.marketing": "Pazarlama iletişimi ve dönüşüm ölçümü için açık rıza.",
  "button.submit": "Gönder",
  "button.cancel": "Vazgeç",
  "button.save": "Kaydet",
  "error.generic": "Bir hata oluştu.",
  "success.saved": "Kaydedildi.",
} as const;

export type TranslationKey = keyof typeof tr;

/** `Record<TranslationKey, string>` tipi EN sözlüğünün eksiksiz olmasını derleme zamanında zorlar. */
const en: Record<TranslationKey, string> = {
  "lang.label": "Language",
  "layout.panel": "Panel",
  "layout.description": "Meta ads optimization panel",
  "layout.tagline": "Ads and growth studio",
  "layout.metaGraph": "Meta Graph",
  "layout.mode": "Mode",
  "layout.modeMock": "MOCK",
  "layout.modeLive": "LIVE",
  "layout.breadcrumb": "Workspace / Clinic ad management",
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
  "shell.workspace": "Workspace",
  "shell.role": "Role",
  "title.studio": "Create ad",
  "title.leadDetail": "Lead details",
  "title.testDetail": "Test details",
  "nav.overview": "Today",
  "nav.studio": "Create ad",
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
  "nav.insights": "Insights",
  "nav.policyRules": "Content rules",
  "nav.clinic": "Clinic and brand",
  "nav.leads": "Leads",
  "nav.billing": "Billing",
  "nav.alerts": "Alerts",
  "account.logout": "Sign out",
  "account.login": "Sign in",
  "account.logoutError": "Could not sign out. Please try again.",
  "login.lead": "Manage your ads, your team's approvals and experiment results in one place.",
  "login.heading": "Sign in",
  "login.email": "Email",
  "login.password": "Password",
  "login.workspace": "Workspace ID",
  "login.submit": "Enter workspace",
  "login.submitting": "Signing in…",
  "login.failed": "Could not sign in. Check your email, password and workspace ID, then try again.",
  "login.firstSetupSummary": "Setting up for the first time?",
  "login.firstSetupBefore": "Set BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD and BOOTSTRAP_CLINIC on the server, then run",
  "login.firstSetupAfter": "The command prints the workspace ID. Setup steps: docs/ad-studio.md.",
  "lead.new": "New Lead",
  "lead.status.new": "Awaiting reply",
  "lead.status.contacted": "In conversation",
  "lead.status.qualified": "Qualified",
  "lead.status.consultation_booked": "Consultation booked",
  "lead.status.travel_planned": "Travel planned",
  "lead.status.treated": "Treatment completed",
  "lead.status.lost": "Lost",
  "lead.consent.grant": "Record explicit consent",
  "lead.consent.granted": "Recorded",
  "lead.consent.pending": "Pending",
  "consent.marketing": "Explicit consent for marketing communication and conversion measurement.",
  "button.submit": "Submit",
  "button.cancel": "Cancel",
  "button.save": "Save",
  "error.generic": "An error occurred.",
  "success.saved": "Saved.",
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
