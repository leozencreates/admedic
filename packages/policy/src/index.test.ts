import { describe, it, expect } from "vitest";
import { checkPolicy } from "./index";
const fixtures = [
  {
    lang: "TR",
    good: "Ekibimizle hizmetler hakkında bilgi alın.",
    guarantee: "Kesin sonuç garantisi",
    before: "Önce/sonra karşılaştırması",
    personal: "Dişleriniz eksik mi?",
    banned: "özel yasak",
  },
  {
    lang: "EN",
    good: "Contact our team for service information.",
    guarantee: "Guaranteed results",
    before: "Before and after",
    personal: "Your missing teeth",
    banned: "restricted phrase",
  },
  {
    lang: "DE",
    good: "Informationen zu unseren Leistungen.",
    guarantee: "Garantierte Ergebnisse",
    before: "Vorher und nachher",
    personal: "Ihre fehlenden Zähne",
    banned: "verbotene phrase",
  },
  {
    lang: "RU",
    good: "Узнайте о наших услугах.",
    guarantee: "Гарантированный результат",
    before: "До и после",
    personal: "Ваши отсутствующие зубы",
    banned: "запрещенная фраза",
  },
  {
    lang: "AR",
    good: "تواصل مع فريقنا لمعرفة المزيد عن الخدمات.",
    guarantee: "نتائج مضمونة",
    before: "قبل وبعد",
    personal: "أسنانك المفقودة",
    banned: "عبارة محظورة",
  },
];
for (const f of fixtures)
  describe(f.lang, () => {
    for (const [rule, text] of [
      ["guarantee", f.guarantee],
      ["before-after", f.before],
      ["personal-attribute", f.personal],
      ["clinic-restriction", f.banned],
    ]) {
      it(`${rule} detects risky text and permits neutral content`, () => {
        const banned = rule === "clinic-restriction" ? [f.banned] : [];
        expect(checkPolicy(text, banned).findings.map((x) => x.rule)).toContain(
          rule,
        );
        expect(checkPolicy(f.good, banned).findings).toEqual([]);
        expect(checkPolicy(text, banned).risk).toBe("HIGH");
      });
    }
  });
it("normalizes invisible characters and ignores blank restrictions", () => {
  expect(checkPolicy("guaran\u200bteed").risk).toBe("HIGH");
  expect(checkPolicy("Service information", [" "]).risk).toBe("LOW");
});
