import {
  BRIEF_LANGUAGES,
  LANGUAGE_LABELS,
  RTL_LANGUAGES,
  type BriefLanguage,
} from "@admedic/llm";

/** Dil listesi ve etiketler tek kanonik kaynaktan gelir: `BriefLanguageEnum` (ADR-0009). */
export { BRIEF_LANGUAGES };
export type BriefLanguageCode = BriefLanguage;
/** Serbest string anahtarla da okunabilsin diye gevşek tipli görünüm (bilinmeyen kod → undefined). */
export const LANG_LABEL: Record<string, string> = LANGUAGE_LABELS;

export function rtlFor(code: string | null | undefined): "rtl" | "auto" {
  return code && RTL_LANGUAGES.has(code.toUpperCase()) ? "rtl" : "auto";
}
