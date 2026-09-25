const RTL_LANGUAGES = new Set(["AR", "HE", "FA", "UR"]);

export const BRIEF_LANGUAGES = ["TR", "EN", "DE", "RU", "AR", "FR", "NL", "PL"] as const;
export type BriefLanguageCode = (typeof BRIEF_LANGUAGES)[number];

export const LANG_LABEL: Record<string, string> = {
  TR: "Türkçe",
  EN: "English",
  DE: "Deutsch",
  RU: "Русский",
  AR: "العربية",
  FR: "Français",
  NL: "Nederlands",
  PL: "Polski",
};

export function rtlFor(code: string | null | undefined): "rtl" | "auto" {
  return code && RTL_LANGUAGES.has(code.toUpperCase()) ? "rtl" : "auto";
}