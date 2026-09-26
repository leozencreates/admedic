import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  NAV_ITEMS,
  SUPPORTED_LANGUAGES,
  UI_LANG_COOKIE,
  dictionaries,
  formatLeadStatus,
  isLanguage,
  languageFromCookieHeader,
  navLinks,
  parseLanguage,
  t,
} from "../app/_lib/i18n";

describe("UI i18n (spec §4: TR/EN)", () => {
  it("yalnızca tr ve en UI dilidir; varsayılan tr", () => {
    expect([...SUPPORTED_LANGUAGES]).toEqual(["tr", "en"]);
    expect(DEFAULT_LANGUAGE).toBe("tr");
    expect(Object.keys(dictionaries).sort()).toEqual(["en", "tr"]);
    expect(isLanguage("de")).toBe(false);
    expect(isLanguage("ru")).toBe(false);
    expect(isLanguage("ar")).toBe(false);
    expect(isLanguage("en")).toBe(true);
  });

  it("uygulama adı sözlükte değildir (APP_NAME ortamdan gelir)", () => {
    expect("app.name" in dictionaries.tr).toBe(false);
    expect("app.name" in dictionaries.en).toBe(false);
    expect(t("app.name", "tr")).toBe("app.name");
  });

  it("tr ve en sözlükleri aynı anahtar kümesine sahiptir ve boş değer içermez", () => {
    const trKeys = Object.keys(dictionaries.tr).sort();
    const enKeys = Object.keys(dictionaries.en).sort();
    expect(enKeys).toEqual(trKeys);
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const [key, value] of Object.entries(dictionaries[lang])) {
        expect(value.trim().length, `${lang}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("t() dile göre çevirir; bilinmeyen dil/anahtar güvenli düşer", () => {
    expect(t("nav.leads", "tr")).toBe("Lead CRM");
    expect(t("nav.billing", "en")).toBe("Billing");
    expect(t("nav.billing", "tr")).toBe("Faturalar");
    expect(t("nav.billing")).toBe(t("nav.billing", DEFAULT_LANGUAGE));
    expect(t("nav.billing", "xx" as never)).toBe("Faturalar");
    expect(t("does.not.exist", "en")).toBe("does.not.exist");
  });

  it("dil çerezini çözer: ui-lang (tr|en), geçersiz değer varsayılana düşer", () => {
    expect(UI_LANG_COOKIE).toBe("ui-lang");
    expect(parseLanguage("en")).toBe("en");
    expect(parseLanguage("de")).toBe("tr");
    expect(parseLanguage(undefined)).toBe("tr");
    expect(languageFromCookieHeader("studio-session=abc; ui-lang=en; other=1")).toBe("en");
    expect(languageFromCookieHeader("ui-lang=ru")).toBe("tr");
    expect(languageFromCookieHeader("")).toBe("tr");
    expect(languageFromCookieHeader(null)).toBe("tr");
  });

  it("nav bağlantıları kreatif ve onay sayfalarını içerir; etiketler dile göre üretilir", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(hrefs).toContain("/creative");
    expect(hrefs).toContain("/approvals");
    expect(new Set(hrefs).size).toBe(hrefs.length);
    const en = navLinks("en");
    expect(en.find((l) => l.href === "/creative")?.label).toBe("Creative Generation");
    expect(navLinks("tr").find((l) => l.href === "/creative")?.label).toBe("Kreatif Üretimi");
    expect(navLinks("tr").find((l) => l.href === "/approvals")?.label).toBe("Onaylar");
    expect(en).toHaveLength(NAV_ITEMS.length);
  });

  it("lead durum etiketleri", () => {
    expect(formatLeadStatus("CONSULTATION_BOOKED", "en")).toBe("Consultation Booked");
    expect(formatLeadStatus("LOST", "tr")).toBe("Kaybedildi");
    expect(formatLeadStatus("UNKNOWN", "tr")).toBe("lead.status.unknown");
  });
});
