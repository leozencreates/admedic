import { describe, it, expect } from "vitest";
import { checkPolicy, checkPolicyBatch } from "./index";
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
    ] as const) {
      it(`${rule} is HIGH risk and neutral content is LOW`, () => {
        const res = checkPolicy(text);
        expect(res.findings.map((x) => x.rule)).toContain(rule);
        expect(res.risk).toBe("HIGH");
        expect(checkPolicy(f.good).risk).toBe("LOW");
        expect(checkPolicy(f.good).findings).toEqual([]);
      });
    }
    it("tenant banned phrase is MEDIUM risk (blocked-only warning), hard rules stay HIGH", () => {
      const banned = checkPolicy(f.banned, [f.banned]);
      expect(banned.findings.map((x) => x.rule)).toContain("clinic-restriction");
      expect(banned.risk).toBe("MEDIUM");
      expect(checkPolicy(f.good, [f.banned]).risk).toBe("LOW");
      expect(checkPolicy(f.guarantee, [f.banned]).risk).toBe("HIGH");
    });
  });
it("normalizes invisible characters and ignores blank restrictions", () => {
  expect(checkPolicy("guaran\u200bteed").risk).toBe("HIGH");
  expect(checkPolicy("Service information", [" "]).risk).toBe("LOW");
});
it("batch aggregates highest risk across items", () => {
  const batch = checkPolicyBatch(
    [
      { id: "a", text: "Contact our team." },
      { id: "b", text: "Guaranteed results" },
      { id: "c", text: "özel yasak" },
    ],
    ["özel yasak"],
  );
  expect(batch.risk).toBe("HIGH");
  expect(batch.results.find((r) => r.id === "a")?.risk).toBe("LOW");
  expect(batch.results.find((r) => r.id === "b")?.risk).toBe("HIGH");
  expect(batch.results.find((r) => r.id === "c")?.risk).toBe("MEDIUM");
});