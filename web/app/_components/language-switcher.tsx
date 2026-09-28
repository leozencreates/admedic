"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_LABEL,
  SUPPORTED_LANGUAGES,
  UI_LANG_COOKIE,
  UI_LANG_MAX_AGE,
  languageFromCookieHeader,
  parseLanguage,
  t,
  type Language,
} from "../_lib/i18n";

/**
 * UI dili seçici. Dil `ui-lang` çerezinde tutulur; seçim çerezi yazar ve `router.refresh()` ile
 * sunucu bileşenlerini (html lang, nav etiketleri) yeniden üretir. İlk render'da çerez/localStorage
 * okunmaz (hydration uyumsuzluğu); sunucu `initial` verirse o kullanılır, yoksa mount sonrası
 * çerezden eşitlenir.
 */
export function LanguageSwitcher({ initial, variant = "dark" }: { initial?: Language; variant?: "dark" | "light" }) {
  const router = useRouter();
  const [lang, setLang] = useState<Language>(initial ?? DEFAULT_LANGUAGE);
  useEffect(() => {
    if (initial !== undefined) return;
    const fromCookie = languageFromCookieHeader(document.cookie);
    setLang((current) => (current === fromCookie ? current : fromCookie));
  }, [initial]);
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = parseLanguage(e.target.value);
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${UI_LANG_COOKIE}=${next}; path=/; max-age=${UI_LANG_MAX_AGE}; samesite=lax${secure}`;
    setLang(next);
    router.refresh();
  }
  return (
    <select value={lang} onChange={handleChange} className={variant === "light" ? "lang-select lang-select--light" : "lang-select"} aria-label={t("lang.label", lang)}>
      {SUPPORTED_LANGUAGES.map((l) => (
        <option key={l} value={l}>{LANGUAGE_LABEL[l]}</option>
      ))}
    </select>
  );
}
