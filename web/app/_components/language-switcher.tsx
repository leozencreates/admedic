"use client";
import { useState } from "react";
import { SUPPORTED_LANGUAGES, getLanguage, setLanguage, type Language } from "../_lib/i18n";
const LANG_LABEL: Record<Language, string> = { tr: "TR", en: "EN", de: "DE", ru: "RU", ar: "AR" };
export function LanguageSwitcher() {
  const [lang, setLang] = useState<Language>(getLanguage());
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as Language;
    setLanguage(next);
    setLang(next);
  }
  return (
    <select value={lang} onChange={handleChange} className="field text-sm" aria-label="Language">
      {SUPPORTED_LANGUAGES.map((l) => (
        <option key={l} value={l}>{LANG_LABEL[l]}</option>
      ))}
    </select>
  );
}
