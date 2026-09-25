import { describe, it, expect } from "vitest";
import { checkPolicy, checkPolicyBatch, DEFAULT_POLICY_RULES } from "./index";
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
  {
    lang: "FR",
    good: "Contactez notre équipe pour plus d'informations.",
    guarantee: "Garantie de résultats",
    before: "Avant et après",
    personal: "Vos dents manquantes",
    banned: "phrase interdite",
  },
  {
    lang: "NL",
    good: "Neem contact op met ons team voor meer informatie.",
    guarantee: "Gegarandeerde resultaten",
    before: "Voor en na",
    personal: "Uw ontbrekende tanden",
    banned: "verboden zin",
  },
  {
    lang: "PL",
    good: "Skontaktuj się z naszym zespołem, aby uzyskać więcej informacji.",
    guarantee: "Gwarancja wyników",
    before: "Przed i po",
    personal: "Brakujące zęby",
    banned: "zabronione zdanie",
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
it("uses supplied rules and reports rule versions; disabled and unmatched rules are annotated", () => {
  const phraseRule = {
    key: "vip-claim", version: 3, matcher: "PHRASES_V1" as const,
    phrases: ["%100 garanti", "kesin çözüm"],
    risk: "HIGH" as const, reason: "Sert iddia", suggestion: "Süreci anlatın", active: true,
  };
  const disabled = { ...DEFAULT_POLICY_RULES[0]!, active: false };
  const res = checkPolicy("Kesin çözüm vaat ediyoruz", [], [phraseRule, disabled]);
  expect(res.findings).toHaveLength(1);
  expect(res.findings[0]?.rule).toBe("vip-claim");
  expect(res.findings[0]?.ruleVersion).toBe(3);
  expect(res.risk).toBe("HIGH");
  expect(res.ruleVersions).toContainEqual({ key: "vip-claim", version: 3, active: true });
  expect(res.ruleVersions).toContainEqual({ key: "guarantee", version: 1, active: false });
  const clean = checkPolicy("Contact our team", [], [phraseRule, disabled]);
  expect(clean.risk).toBe("LOW");
  expect(clean.findings).toEqual([]);
});