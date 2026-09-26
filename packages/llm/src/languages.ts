import { z } from "zod";

/**
 * Kreatif/asistan dilleri — TEK kanonik kaynak (ADR-0009). Diğer listeler
 * (LOCALIZATION haritaları, UI seçenekleri, etiketler) buradan türetilir.
 */
export const BriefLanguageEnum = z.enum(["TR", "EN", "DE", "RU", "AR", "FR", "NL", "PL"]);
export type BriefLanguage = z.infer<typeof BriefLanguageEnum>;
export const BRIEF_LANGUAGES = BriefLanguageEnum.options;

/** Kullanıcıya gösterilen dil adları (kendi dilinde). */
export const LANGUAGE_LABELS: Record<BriefLanguage, string> = {
  TR: "Türkçe",
  EN: "English",
  DE: "Deutsch",
  RU: "Русский",
  AR: "العربية",
  FR: "Français",
  NL: "Nederlands",
  PL: "Polski",
};

/** Sağdan sola yazılan diller; şimdilik yalnızca AR üretiliyor, liste genişlemeye açık. */
export const RTL_LANGUAGES: ReadonlySet<string> = new Set(["AR", "HE", "FA", "UR"]);

export function isBriefLanguage(value: unknown): value is BriefLanguage {
  return typeof value === "string" && (BRIEF_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Serbest dil kodunu ("de", "de-DE", "en_US", "TR") kanonik koda indirger;
 * tanınmayan/boş değerde `fallback` döner.
 */
export function normalizeLanguageCode(
  value: string | null | undefined,
  fallback: BriefLanguage = "TR",
): BriefLanguage {
  const code = (value ?? "").trim().slice(0, 2).toUpperCase();
  return isBriefLanguage(code) ? code : fallback;
}
