/**
 * Tek etiket kaynağı (ADR-0016 · K8/K9): ekranda ham kod (PUBLISHED_PAUSED, LEAD_AD, OWNER…) görünmez.
 * Etiketler "sıradaki adım" dilindedir (K8-B) ve renklerin tek anlamı vardır:
 *   amber = bir insandan eylem bekleniyor · blue = süreç ilerliyor · green = canlı/tamam ·
 *   red = sorun · gray = pasif ya da kapandı. Marka moru (violet) durum anlatmaz.
 * Terimler Türkçe birincildir (K9-C); Meta'nın İngilizce adı yalnızca ipucunda kullanılır.
 * Bilinmeyen kod ekranda kod olarak değil "Bilinmeyen durum" olarak görünür.
 */
import { CTA_LABELS } from "@admedic/llm";
import type { Tone } from "../_components/ui";
import { formatLeadStatus, type Language } from "./i18n";

export interface StatusStyle {
  label: string;
  tone: Tone;
}

const UNKNOWN: StatusStyle = { label: "Bilinmeyen durum", tone: "gray" };

function lookup(map: Record<string, StatusStyle>, key: string | null | undefined): StatusStyle {
  if (!key) return UNKNOWN;
  return map[key] ?? UNKNOWN;
}

function label(map: Record<string, string>, key: string | null | undefined, fallback = "—"): string {
  if (!key) return fallback;
  return map[key] ?? fallback;
}

// ── Lead ────────────────────────────────────────────────────────────────────────

const LEAD_STATUS_TONE: Record<string, Tone> = {
  NEW: "blue", // "Yanıt bekliyor" amber vurgusu gelen kutusu kuralından gelir (inbox.ts), durumdan değil.
  CONTACTED: "blue",
  QUALIFIED: "blue",
  CONSULTATION_BOOKED: "blue",
  TRAVEL_PLANNED: "blue",
  TREATED: "green",
  LOST: "gray",
};

/** Lead durumu; etiket metni i18n sözlüğünden (TR/EN) gelir. */
export function leadStatusStyle(status: string | null | undefined, lang?: Language): StatusStyle {
  if (!status || !(status in LEAD_STATUS_TONE)) return UNKNOWN;
  return { label: formatLeadStatus(status, lang), tone: LEAD_STATUS_TONE[status] };
}

/** Lead akışındaki sıra (aşama çubuğu ve "sonraki adım" düğmeleri için). */
export const LEAD_STAGES = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "CONSULTATION_BOOKED",
  "TRAVEL_PLANNED",
  "TREATED",
] as const;

/** Düğme metni: "Görüşülüyor olarak işaretle" gibi. */
export function leadTransitionLabel(next: string, lang?: Language): string {
  if (next === "LOST") return "Kaybedildi olarak işaretle";
  return `${formatLeadStatus(next, lang)} olarak işaretle`;
}

/** Hazır kayıp nedenleri (raporlanabilir; "Diğer" serbest metin ister). */
export const LOST_REASONS = [
  "Fiyat",
  "Başka klinik seçti",
  "Tedaviye uygun değil",
  "İletişim kurulamadı",
  "Seyahat planı iptal oldu",
  "Tedaviyi ertelemeye karar verdi",
] as const;

// ── Kanal, ülke, dil ────────────────────────────────────────────────────────────

const CHANNEL_LABEL: Record<string, string> = {
  LEAD_AD: "Meta formu",
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram DM",
  MESSENGER: "Messenger",
  SMS: "SMS",
};

export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return "—";
  return CHANNEL_LABEL[channel.toUpperCase()] ?? "Diğer kanal";
}

let languageNames: Intl.DisplayNames | null = null;
let regionNames: Intl.DisplayNames | null = null;

/** ISO 639 dil kodu → Türkçe ad: "de" → "Almanca". */
export function languageName(code: string | null | undefined): string {
  if (!code) return "—";
  try {
    languageNames ??= new Intl.DisplayNames(["tr"], { type: "language" });
    return languageNames.of(code.toLowerCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/** ISO 3166 ülke kodu → Türkçe ad: "DE" → "Almanya". */
export function countryName(code: string | null | undefined): string {
  if (!code) return "—";
  try {
    regionNames ??= new Intl.DisplayNames(["tr"], { type: "region" });
    return regionNames.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

// ── Konuşma ─────────────────────────────────────────────────────────────────────

// ── Kampanya ────────────────────────────────────────────────────────────────────

const CAMPAIGN_WORKFLOW: Record<string, StatusStyle> = {
  DRAFT: { label: "Taslak", tone: "gray" },
  IN_REVIEW: { label: "Onay bekliyor", tone: "amber" },
  APPROVED: { label: "Meta'ya yüklenmeye hazır", tone: "blue" },
  REJECTED: { label: "Düzeltme istendi", tone: "red" },
  PUBLISHED_PAUSED: { label: "Etkinleştirme bekliyor", tone: "amber" },
  ACTIVE: { label: "Yayında", tone: "green" },
  ARCHIVED: { label: "Arşivde", tone: "gray" },
};

/**
 * Kampanya iş akışı durumu. Yayını yarım kalan onaylı kampanya (Meta'da kısmen kurulu) ve
 * Meta'da duraklatılmış yayındaki kampanya ayrı etiket alır.
 */
export function campaignWorkflowStyle(
  status: string | null | undefined,
  options: { publishIncomplete?: boolean; metaPaused?: boolean } = {},
): StatusStyle {
  if (status === "APPROVED" && options.publishIncomplete) return { label: "Yükleme yarım kaldı", tone: "amber" };
  if (status === "ACTIVE" && options.metaPaused) return { label: "Duraklatıldı", tone: "gray" };
  return lookup(CAMPAIGN_WORKFLOW, status);
}

/** Kampanya/reklam seti/reklamın Meta'daki durumu (EntityStatus). */
const ENTITY_STATUS: Record<string, StatusStyle> = {
  ACTIVE: { label: "Etkin", tone: "green" },
  PAUSED: { label: "Duraklatıldı", tone: "gray" },
  ARCHIVED: { label: "Arşivde", tone: "gray" },
  DRAFT: { label: "Taslak", tone: "gray" },
  DELETED: { label: "Silindi", tone: "gray" },
};
export const entityStatusStyle = (key: string | null | undefined) => lookup(ENTITY_STATUS, key);

/** Kampanyanın Meta incelemesi (reklamlardan toplanan, ADR-0015). */
const META_REVIEW: Record<string, StatusStyle> = {
  DISAPPROVED: { label: "Meta reddetti", tone: "red" },
  WITH_ISSUES: { label: "Sorunlu", tone: "amber" },
  PENDING_REVIEW: { label: "İncelemede", tone: "blue" },
  NO_ISSUES: { label: "Sorun yok", tone: "green" },
  UNKNOWN: { label: "Henüz incelenmedi", tone: "gray" },
};
export const metaReviewStyle = (key: string | null | undefined) =>
  key ? lookup(META_REVIEW, key) : META_REVIEW.UNKNOWN;

/** Reklamın Meta `effective_status` değeri. */
const AD_EFFECTIVE_STATUS: Record<string, StatusStyle> = {
  ACTIVE: { label: "Etkin", tone: "green" },
  PAUSED: { label: "Duraklatıldı", tone: "gray" },
  CAMPAIGN_PAUSED: { label: "Kampanya duraklatıldı", tone: "gray" },
  ADSET_PAUSED: { label: "Reklam seti duraklatıldı", tone: "gray" },
  PENDING_REVIEW: { label: "İncelemede", tone: "blue" },
  IN_PROCESS: { label: "İşleniyor", tone: "blue" },
  PREAPPROVED: { label: "Ön onaylı", tone: "blue" },
  WITH_ISSUES: { label: "Sorunlu", tone: "amber" },
  DISAPPROVED: { label: "Meta reddetti", tone: "red" },
  PENDING_BILLING_INFO: { label: "Ödeme bilgisi bekleniyor", tone: "amber" },
  ARCHIVED: { label: "Arşivde", tone: "gray" },
  DELETED: { label: "Silindi", tone: "gray" },
};
export const adEffectiveStatusStyle = (key: string | null | undefined) => lookup(AD_EFFECTIVE_STATUS, key);

/** Meta kampanya hedefi (OUTCOME_*) → Türkçe (Meta'nın Türkçe arayüzündeki adlar). */
const OBJECTIVE_LABEL: Record<string, string> = {
  OUTCOME_LEADS: "Potansiyel müşteri",
  OUTCOME_SALES: "Satış",
  OUTCOME_TRAFFIC: "Trafik",
  OUTCOME_AWARENESS: "Bilinirlik",
  OUTCOME_ENGAGEMENT: "Etkileşim",
  OUTCOME_APP_PROMOTION: "Uygulama tanıtımı",
};
export const objectiveLabel = (key: string | null | undefined) => label(OBJECTIVE_LABEL, key);

/** Bütçe türü (K9-C: Türkçe birincil, kısaltma parantezde). */
const BUDGET_MODE_LABEL: Record<string, string> = {
  CBO: "Kampanya bütçesi (CBO)",
  ABO: "Reklam seti bütçesi (ABO)",
};
export const budgetModeLabel = (key: string | null | undefined) => label(BUDGET_MODE_LABEL, key);

/** Reklam eylem düğmesi (CTA). */
export function ctaLabel(cta: string | null | undefined): string {
  if (!cta) return "—";
  return (CTA_LABELS as Record<string, string>)[cta] ?? "Diğer";
}

// ── İçerik (stüdyo) ─────────────────────────────────────────────────────────────

const STUDIO_STATUS: Record<string, StatusStyle> = {
  DRAFT: { label: "Taslak", tone: "gray" },
  IN_REVIEW: { label: "Onay bekliyor", tone: "amber" },
  APPROVED: { label: "Onaylandı", tone: "green" },
  REJECTED: { label: "Düzeltme istendi", tone: "red" },
};
export const studioStatusStyle = (key: string | null | undefined) => lookup(STUDIO_STATUS, key);

const POLICY_RISK: Record<string, StatusStyle> = {
  LOW: { label: "Düşük risk", tone: "green" },
  MEDIUM: { label: "Orta risk", tone: "amber" },
  HIGH: { label: "Yüksek risk", tone: "red" },
};
export const policyRiskStyle = (key: string | null | undefined) =>
  key ? lookup(POLICY_RISK, key.toUpperCase()) : { label: "İçerik kontrolü yapılmadı", tone: "gray" as Tone };

const EXPERIMENT_STATUS: Record<string, StatusStyle> = {
  DRAFT: { label: "Taslak", tone: "gray" },
  RUNNING: { label: "Veri toplanıyor", tone: "blue" },
  PAUSED: { label: "Duraklatıldı", tone: "gray" },
  COMPLETED: { label: "Tamamlandı", tone: "green" },
  ARCHIVED: { label: "Arşivde", tone: "gray" },
};
export const experimentStatusStyle = (key: string | null | undefined) => lookup(EXPERIMENT_STATUS, key);

// ── Onay, öneri, ajan kararı ────────────────────────────────────────────────────

const APPROVAL: Record<string, StatusStyle> = {
  PENDING: { label: "Onay bekliyor", tone: "amber" },
  APPROVED: { label: "Onaylandı", tone: "green" },
  REJECTED: { label: "Reddedildi", tone: "gray" },
  NOT_REQUIRED: { label: "Onay gerekmez", tone: "gray" },
  FAILED: { label: "Uygulanamadı", tone: "red" },
};
export const approvalStyle = (key: string | null | undefined) => lookup(APPROVAL, key);

/**
 * Ajan kararı kayıtlarında (AgentDecision) PENDING, onay kutusunda bekleyen bir iş değildir;
 * karar kaydedilmiş ama uygulanmamıştır. Amber "Onay bekliyor" yanıltıcı olur.
 */
const DECISION_APPROVAL: Record<string, StatusStyle> = {
  ...APPROVAL,
  PENDING: { label: "Uygulanmadı", tone: "gray" },
};
export const decisionApprovalStyle = (key: string | null | undefined) => lookup(DECISION_APPROVAL, key);

/** Ajan kararı eylemleri durum değildir; nötr gösterilir. */
const ACTION_LABEL: Record<string, string> = {
  INCREASE_BUDGET: "Bütçeyi artır",
  DECREASE_BUDGET: "Bütçeyi azalt",
  PAUSE: "Duraklat",
  UNPAUSE: "Yeniden başlat",
  ALLOCATE: "Bütçeyi dağıt",
  EXPLORE: "Keşif",
  WINNER_PROMOTION: "Kazananı öne çıkar",
  NEW_EXPERIMENT: "Yeni A/B testi",
  KEEP: "Koru",
  CREATE_VARIANT: "Varyant oluştur",
  SCALE_CAMPAIGN: "Kampanyayı büyüt",
  ALERT: "Uyarı",
};
export function actionStyle(key: string | null | undefined): StatusStyle {
  if (!key) return UNKNOWN;
  return { label: ACTION_LABEL[key] ?? "Diğer eylem", tone: "gray" };
}

const TARGET_TYPE_LABEL: Record<string, string> = {
  CAMPAIGN: "Kampanya",
  ADSET: "Reklam seti",
  AD: "Reklam",
};
export const targetTypeLabel = (key: string | null | undefined) => label(TARGET_TYPE_LABEL, key);

const RECOMMENDATION_STATUS: Record<string, StatusStyle> = {
  DRAFT: { label: "Taslak", tone: "gray" },
  PENDING: { label: "Onay bekliyor", tone: "amber" },
  APPROVED: { label: "Onaylandı, uygulanmayı bekliyor", tone: "amber" },
  APPLIED: { label: "Uygulandı", tone: "green" },
  REJECTED: { label: "Yok sayıldı", tone: "gray" },
  EXPIRED: { label: "Süresi doldu", tone: "gray" },
};
export const recommendationStatusStyle = (key: string | null | undefined) => lookup(RECOMMENDATION_STATUS, key);

const PRIORITY_LABEL: Record<string, string> = {
  HIGH: "Yüksek öncelik",
  MEDIUM: "Orta öncelik",
  LOW: "Düşük öncelik",
};
export const priorityLabel = (key: string | null | undefined) => label(PRIORITY_LABEL, key);

/** Bütçe değişikliğinin Meta'ya uygulanma durumu. */
const BUDGET_CHANGE_STATUS: Record<string, StatusStyle> = {
  PENDING: { label: "Uygulanıyor", tone: "blue" },
  APPLIED: { label: "Meta'ya uygulandı", tone: "green" },
  FAILED: { label: "Uygulanamadı", tone: "red" },
  SKIPPED: { label: "Atlandı", tone: "gray" },
};
export const budgetChangeStatusStyle = (key: string | null | undefined) => lookup(BUDGET_CHANGE_STATUS, key);

// ── Uyarı ──────────────────────────────────────────────────────────────────────

const SEVERITY: Record<string, StatusStyle> = {
  INFO: { label: "Bilgi", tone: "blue" },
  WARNING: { label: "Önemli", tone: "amber" },
  CRITICAL: { label: "Kritik", tone: "red" },
};
export const severityStyle = (key: string | null | undefined) => lookup(SEVERITY, key);

const ALERT_STATUS: Record<string, StatusStyle> = {
  OPEN: { label: "Açık", tone: "amber" },
  ACKED: { label: "Görüldü", tone: "blue" },
  RESOLVED: { label: "Çözüldü", tone: "gray" },
};
export const alertStatusStyle = (key: string | null | undefined) => lookup(ALERT_STATUS, key);

// ── Bağlantı, üyelik, rol ──────────────────────────────────────────────────────

const META_CONNECTION_STATUS: Record<string, StatusStyle> = {
  CONNECTED: { label: "Bağlı", tone: "green" },
  DEGRADED: { label: "İzin eksik", tone: "amber" },
  EXPIRED: { label: "Süresi doldu", tone: "red" },
  REVOKED: { label: "Erişim kaldırıldı", tone: "red" },
};
export const metaConnectionStyle = (key: string | null | undefined) => lookup(META_CONNECTION_STATUS, key);

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Hesap sahibi",
  ADMIN: "Yönetici",
  MEDIA_BUYER: "Reklam uzmanı",
  PATIENT_COORDINATOR: "Hasta koordinatörü",
  ANALYST: "Analist",
  VIEWER: "İzleyici",
};
export const roleLabel = (key: string | null | undefined) => label(ROLE_LABEL, key, "Bilinmeyen rol");

const MEMBERSHIP_STATUS_LABEL: Record<string, string> = {
  PENDING: "Davet bekliyor",
  ACTIVE: "Etkin",
  DISABLED: "Devre dışı",
};
export const membershipStatusLabel = (key: string | null | undefined) => label(MEMBERSHIP_STATUS_LABEL, key);

// ── Rıza (KVKK) ─────────────────────────────────────────────────────────────────

const CONSENT_TYPE_LABEL: Record<string, string> = {
  MARKETING: "Pazarlama iletişimi ve dönüşüm ölçümü",
  DATA_PROCESSING: "Talebe yanıt için veri işleme",
  HEALTH_QUESTIONNAIRE: "Sağlık formu",
};
export const consentTypeLabel = (key: string | null | undefined) => label(CONSENT_TYPE_LABEL, key);

const CONSENT_STATUS: Record<string, StatusStyle> = {
  GRANTED: { label: "Verildi", tone: "green" },
  DENIED: { label: "Verilmedi", tone: "gray" },
  WITHDRAWN: { label: "Geri çekildi", tone: "gray" },
  PENDING: { label: "Bekliyor", tone: "amber" },
};
export const consentStatusStyle = (key: string | null | undefined) => lookup(CONSENT_STATUS, key);

const CONSENT_SOURCE_LABEL: Record<string, string> = {
  INSTANT_FORM: "Meta Anında Form",
  PANEL: "Panelden kayıt",
  API: "Sistem entegrasyonu",
};
export const consentSourceLabel = (key: string | null | undefined) =>
  label(CONSENT_SOURCE_LABEL, key, "Kaynak belirtilmemiş");

const CONSENT_BASIS_LABEL: Record<string, string> = {
  CHECKBOX_RESPONSE: "formdaki kutu işaretli (Meta yanıtı)",
  REQUIRED_CHECKBOX: "zorunlu kutu (form ancak işaretlenerek gönderilebilir)",
  WRITTEN_MESSAGE: "hastanın yazılı mesajı (WhatsApp, Messenger, Instagram)",
  EMAIL: "hastanın e-postası",
  SIGNED_FORM: "imzalı form",
  RECORDED_CALL: "kayıtlı telefon görüşmesi",
};
export const consentBasisLabel = (key: string | null | undefined) => label(CONSENT_BASIS_LABEL, key, "Belirtilmemiş");

// ── İçerik kuralları, eylem düğmesi metni (Faz 1 · kalan sayfalar) ─────────────

/** İçerik kuralı türü; sürüm eki (PHRASES_V1) ekranda görünmez. */
const POLICY_MATCHER_LABEL: Record<string, string> = {
  PHRASES_V1: "İfade listesi",
  GUARANTEE_V1: "Garanti / kesin sonuç",
  BEFORE_AFTER_V1: "Önce/sonra",
  PERSONAL_ATTRIBUTE_V1: "Kişisel özellik",
};
/** Yeni kural formundaki tür seçenekleri (sıra korunur). */
export const POLICY_MATCHERS = Object.keys(POLICY_MATCHER_LABEL);
export const policyMatcherLabel = (key: string | null | undefined) =>
  label(POLICY_MATCHER_LABEL, key, "Diğer kural türü");

/** Yerleşik içerik kurallarının adı (kural anahtarı ekranda görünmez); kullanıcı tanımlı kural kendi anahtarıyla. */
const POLICY_RULE_NAME: Record<string, string> = {
  guarantee: "Garanti vaadi",
  "before-after": "Önce/sonra karşılaştırması",
  "personal-attribute": "Kişisel özellik varsayımı",
};
export const policyRuleName = (key: string) => POLICY_RULE_NAME[key] ?? key;

/** Optimizasyon kuralı kayıtları (ajan motoru): sürüm kodu yerine ad ve açıklama. */
const OPTIMIZATION_RULE_TEXT: Record<string, { name: string; description: string }> = {
  policy_v1: {
    name: "Bütçe koruma kuralları",
    description: "Harcama sınırları, bütçe artırma/azaltma eşikleri ve zarar durdurma (stop-loss) kuralları.",
  },
};
export const optimizationRuleText = (name: string, description: string | null) =>
  OPTIMIZATION_RULE_TEXT[name] ?? { name, description };

/** İçerik kuralının açık/kapalı durumu. */
export const ruleActiveStyle = (active: boolean): StatusStyle =>
  active ? { label: "Etkin", tone: "green" } : { label: "Kapalı", tone: "gray" };

/**
 * Eylem düğmesi metni: Meta kodu (LEARN_MORE) etikete çevrilir; eski taslaklarda serbest
 * metin olarak yazılmış eylem düğmesi ("Jetzt beraten lassen") olduğu gibi gösterilir.
 */
export function ctaDisplay(cta: string | null | undefined): string {
  if (!cta) return "—";
  return /^[A-Z][A-Z_]*$/.test(cta) ? ctaLabel(cta) : cta;
}

// ── Kampanya planlayıcı (Faz 1) ─────────────────────────────────────────────────

/** Meta'ya yükleme adımı (`campaign-publish.ts` `PublishStep`) → "Son hata" satırındaki adım adı. */
const PUBLISH_STEP_LABEL: Record<string, string> = {
  structure: "reklam seti yapısı",
  campaign: "kampanya",
  locales: "dil hedeflemesi",
  leadForms: "Anında Form",
  adSets: "reklam seti",
  creatives: "reklam içeriği",
  ads: "reklam",
  complete: "tamamlama",
};
export const publishStepLabel = (key: string | null | undefined) => label(PUBLISH_STEP_LABEL, key, "yükleme");
