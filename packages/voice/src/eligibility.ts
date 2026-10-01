/**
 * "Müsait lead" kuralı (ADR-0026): sesli ajanın bir lead'i arayabilmesi için sağlanması gereken koşullar.
 * Saf modül: veritabanı ve ağ yok; elle ve otomatik arama aynı kuralı kullanır.
 */

/** Arama saatleri, lead'in yerel saatine göre (başlangıç dahil, bitiş hariç). */
export const CALL_WINDOW = { startHour: 9, endHour: 20 } as const;
/** Lead başına en fazla arama denemesi. */
export const MAX_CALL_ATTEMPTS = 3;
/** İki deneme arasında en az bekleme. */
export const MIN_CALL_GAP_MS = 24 * 3600_000;
/** Aranabilir aşamalar: randevu alındıktan sonra ilişki insandadır. */
export const CALLABLE_STATUSES: readonly string[] = ["NEW", "CONTACTED", "QUALIFIED"];

export type CallTrigger = "MANUAL" | "AUTO";

export type CallBlocker =
  | "NO_PHONE"
  | "INVALID_PHONE"
  | "NO_CALL_CONSENT"
  | "STAGE"
  | "HUMAN_OWNED"
  | "UNKNOWN_TIMEZONE"
  | "OUTSIDE_HOURS"
  | "MAX_ATTEMPTS"
  | "TOO_SOON"
  | "CALL_IN_PROGRESS"
  | "ALREADY_REACHED";

export interface CallFacts {
  status: string;
  /** Çözülmüş telefon (şifresiz); yoksa null. */
  phone: string | null;
  /** Telefonla aranma rızası (ConsentType.PHONE_CALL) verilmiş ve geri çekilmemiş mi? */
  callConsent: boolean;
  /** Konuşmalardan birini koordinatör devralmış mı? */
  humanOwned: boolean;
  /** Daha önce çevrilen arama sayısı. */
  attempts: number;
  lastAttemptAt: Date | null;
  /** Sonucu henüz gelmemiş arama var mı? */
  activeCall: boolean;
  /** Ajan lead'le daha önce görüşebildi mi? */
  reached: boolean;
}

/**
 * Ülke kodu → o ülkedeki saat dilimleri. Birden çok dilimi olan ülkede en batı ve en doğu dilim yazılır;
 * arama yalnızca ikisinde de saat uygunsa yapılır. Listede olmayan ülke aranmaz (`UNKNOWN_TIMEZONE`).
 */
const CALLING_CODE_ZONES: Record<string, readonly string[]> = {
  "90": ["Europe/Istanbul"],
  "49": ["Europe/Berlin"],
  "44": ["Europe/London"],
  "31": ["Europe/Amsterdam"],
  "32": ["Europe/Brussels"],
  "33": ["Europe/Paris"],
  "34": ["Europe/Madrid"],
  "39": ["Europe/Rome"],
  "41": ["Europe/Zurich"],
  "43": ["Europe/Vienna"],
  "45": ["Europe/Copenhagen"],
  "46": ["Europe/Stockholm"],
  "47": ["Europe/Oslo"],
  "48": ["Europe/Warsaw"],
  "353": ["Europe/Dublin"],
  "1": ["America/Los_Angeles", "America/New_York"],
  "971": ["Asia/Dubai"],
  "966": ["Asia/Riyadh"],
  "974": ["Asia/Qatar"],
  "965": ["Asia/Kuwait"],
  "973": ["Asia/Bahrain"],
  "968": ["Asia/Muscat"],
  "964": ["Asia/Baghdad"],
  "994": ["Asia/Baku"],
};

/**
 * Telefonu E.164 biçimine getirir ("+" ve 7–15 hane). Ülke kodu olmayan (yerel) numara tahmin edilmez.
 * `00` uluslararası ön eki `+` sayılır.
 */
export function normalizeE164(phone: string | null | undefined): string | null {
  const compact = (phone ?? "").replace(/[\s().-]/g, "");
  const candidate = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  return /^\+[1-9]\d{6,14}$/.test(candidate) ? candidate : null;
}

/** E.164 numaranın saat dilimleri (en uzun ülke kodu eşleşmesi); bilinmiyorsa null. */
export function zonesForNumber(e164: string): readonly string[] | null {
  const digits = e164.replace(/^\+/, "");
  for (const length of [3, 2, 1]) {
    const zones = CALLING_CODE_ZONES[digits.slice(0, length)];
    if (zones) return zones;
  }
  return null;
}

function localHour(now: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now);
  return Number(hour);
}

/** Verilen saat dilimlerinin hepsinde arama saatleri içinde mi? */
export function withinCallWindow(now: Date, zones: readonly string[]): boolean {
  return zones.every((zone) => {
    const hour = localHour(now, zone);
    return hour >= CALL_WINDOW.startHour && hour < CALL_WINDOW.endHour;
  });
}

/** Aramayı engelleyen nedenler; boş dizi lead'in müsait olduğunu söyler. */
export function callBlockers(facts: CallFacts, trigger: CallTrigger, now: Date = new Date()): CallBlocker[] {
  const blockers: CallBlocker[] = [];
  if (!CALLABLE_STATUSES.includes(facts.status)) blockers.push("STAGE");
  if (!facts.callConsent) blockers.push("NO_CALL_CONSENT");
  if (facts.humanOwned) blockers.push("HUMAN_OWNED");
  if (!facts.phone) blockers.push("NO_PHONE");
  else {
    const e164 = normalizeE164(facts.phone);
    if (!e164) blockers.push("INVALID_PHONE");
    else {
      const zones = zonesForNumber(e164);
      if (!zones) blockers.push("UNKNOWN_TIMEZONE");
      else if (!withinCallWindow(now, zones)) blockers.push("OUTSIDE_HOURS");
    }
  }
  if (facts.activeCall) blockers.push("CALL_IN_PROGRESS");
  if (facts.attempts >= MAX_CALL_ATTEMPTS) blockers.push("MAX_ATTEMPTS");
  else if (facts.lastAttemptAt && now.getTime() - facts.lastAttemptAt.getTime() < MIN_CALL_GAP_MS) blockers.push("TOO_SOON");
  // Otomatik arama, ajanın daha önce görüştüğü lead'i yeniden aramaz; koordinatör isterse elle arar.
  if (trigger === "AUTO" && facts.reached) blockers.push("ALREADY_REACHED");
  return blockers;
}

/** Engel nedenlerinin panelde gösterilen açıklamaları. */
export const CALL_BLOCKER_LABELS: Record<CallBlocker, string> = {
  NO_PHONE: "Telefon numarası yok.",
  INVALID_PHONE: "Telefon numarası ülke koduyla (+90… gibi) yazılmamış.",
  NO_CALL_CONSENT: "Telefonla aranma rızası kayıtlı değil.",
  STAGE: "Lead bu aşamada ajan tarafından aranmaz (yalnızca yeni, iletişim kurulan ve nitelikli lead'ler).",
  HUMAN_OWNED: "Konuşmayı bir koordinatör devralmış.",
  UNKNOWN_TIMEZONE: "Numaranın ülkesi için arama saatleri tanımlı değil.",
  OUTSIDE_HOURS: `Lead'in yerel saati arama saatleri (${String(CALL_WINDOW.startHour).padStart(2, "0")}:00–${CALL_WINDOW.endHour}:00) dışında.`,
  MAX_ATTEMPTS: `En fazla ${MAX_CALL_ATTEMPTS} arama denemesi yapıldı.`,
  TOO_SOON: "Son denemenin üzerinden 24 saat geçmedi.",
  CALL_IN_PROGRESS: "Sonucu bekleyen bir arama var.",
  ALREADY_REACHED: "Ajan bu lead'le daha önce görüştü.",
};
