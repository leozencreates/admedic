import { describe, it, expect } from "vitest";
import { checkPolicy, checkPolicyBatch, DEFAULT_POLICY_RULES, POLICY_VERSION } from "./index";

/**
 * Her dil için kural başına pozitif (eşleşmeli) ve negatif (eşleşmemeli, "yakın
 * kaçış") örnekler (spec §6). Negatifler kalıp köklerine benzeyen ama politika
 * ihlali olmayan gerçek kullanımlardır.
 */
const fixtures = [
  {
    lang: "TR",
    good: "Ekibimizle hizmetler hakkında bilgi alın.",
    guarantee: ["Kesin sonuç garantisi", "%100 GARANTİLİ SONUÇ", "KESİN SONUÇ"],
    guaranteeNeg: ["Sonuçlar kişiye göre değişir.", "Sonuç görüşmede değerlendirilir."],
    before: ["Önce/sonra karşılaştırması", "ÖNCE VE SONRA fotoğrafları", "önce – sonra"],
    beforeNeg: ["Tedavi öncesinde ve sonrasında bilgilendirme yapılır.", "Randevudan önce formu doldurun, sonra bize ulaşın."],
    personal: ["Dişleriniz eksik mi?", "SAÇLARINIZ DÖKÜLÜYOR MU?", "Kel misiniz?"],
    personalNeg: ["Saç dökülmesi hakkında bilgi alın.", "Eksik diş tedavileri hakkında bilgi."],
    banned: "özel yasak",
  },
  {
    lang: "EN",
    good: "Contact our team for service information.",
    guarantee: ["Guaranteed results", "We GUARANTEE it"],
    guaranteeNeg: ["Results vary from person to person."],
    before: ["Before and after", "BEFORE/AFTER photos", "before – after"],
    beforeNeg: ["Aftercare guidance is provided.", "Before your visit, read the guide; afterwards we follow up."],
    personal: ["Your missing teeth", "Are you bald?"],
    personalNeg: ["Information about missing teeth treatments."],
    banned: "restricted phrase",
  },
  {
    lang: "DE",
    good: "Informationen zu unseren Leistungen.",
    guarantee: ["Garantierte Ergebnisse", "GARANTIERT erfolgreich"],
    guaranteeNeg: ["Ergebnisse können variieren."],
    before: ["Vorher und nachher", "VORHER/NACHHER-Bilder"],
    beforeNeg: ["Vorher informieren wir Sie; nachher betreuen wir Sie."],
    personal: ["Ihre fehlenden Zähne", "Sind Sie kahl?"],
    personalNeg: ["Informationen zu fehlenden Zähnen."],
    banned: "verbotene phrase",
  },
  {
    lang: "RU",
    good: "Узнайте о наших услугах.",
    guarantee: ["Гарантированный результат", "ГАРАНТИЯ результата"],
    guaranteeNeg: ["Результаты индивидуальны."],
    before: ["До и после", "ДО/ПОСЛЕ"],
    beforeNeg: ["До приёма и после него мы на связи."],
    personal: ["Ваши отсутствующие зубы", "Вы лысый?"],
    personalNeg: ["Информация о лечении зубов."],
    banned: "запрещенная фраза",
  },
  {
    lang: "AR",
    good: "تواصل مع فريقنا لمعرفة المزيد عن الخدمات.",
    guarantee: ["نتائج مضمونة", "نجاح مضمون"],
    guaranteeNeg: ["النتائج تختلف من شخص لآخر."],
    before: ["قبل وبعد", "قبل / بعد"],
    beforeNeg: ["قبل الموعد وبعد العلاج نقدم الدعم."],
    personal: ["أسنانك المفقودة", "هل أنت أصلع؟"],
    personalNeg: ["معلومات عن علاج الأسنان."],
    banned: "عبارة محظورة",
  },
  {
    lang: "FR",
    good: "Contactez notre équipe pour plus d'informations.",
    guarantee: ["Garantie de résultats", "RÉSULTATS GARANTIS"],
    guaranteeNeg: ["Les résultats varient selon les personnes."],
    before: ["Avant et après", "AVANT/APRÈS"],
    beforeNeg: ["Avant votre visite et après votre séjour, nous restons disponibles."],
    personal: ["Vos dents manquantes", "Êtes-vous chauve ?"],
    personalNeg: ["Informations sur les dents manquantes."],
    banned: "phrase interdite",
  },
  {
    lang: "NL",
    good: "Neem contact op met ons team voor meer informatie.",
    guarantee: ["Gegarandeerde resultaten", "GEGARANDEERD succes"],
    guaranteeNeg: ["Resultaten kunnen per persoon verschillen."],
    before: ["Voor en na", "VOOR/NA foto's", "voor – na"],
    beforeNeg: ["Vul uw voornaam in; dit is voornamelijk voor de intake.", "Voor de behandeling en na afloop begeleiden wij u."],
    personal: ["Uw ontbrekende tanden", "Bent u kaal?"],
    personalNeg: ["Informatie over ontbrekende tanden."],
    banned: "verboden zin",
  },
  {
    lang: "PL",
    good: "Skontaktuj się z naszym zespołem, aby uzyskać więcej informacji.",
    guarantee: ["Gwarancja wyników", "GWARANTOWANY efekt"],
    guaranteeNeg: ["Wyniki mogą się różnić."],
    before: ["Przed i po", "PRZED/PO"],
    beforeNeg: ["Godziny przedpołudniowe i popołudniowe.", "Przed wizytą i po zabiegu zapewniamy opiekę."],
    personal: ["Brakujące zęby", "Czy jesteś łysy?"],
    personalNeg: ["Informacje o leczeniu zębów."],
    banned: "zabronione zdanie",
  },
];
for (const f of fixtures)
  describe(f.lang, () => {
    for (const [rule, positives, negatives] of [
      ["guarantee", f.guarantee, f.guaranteeNeg],
      ["before-after", f.before, f.beforeNeg],
      ["personal-attribute", f.personal, f.personalNeg],
    ] as const) {
      it(`${rule}: positives are HIGH, negatives and neutral content are LOW`, () => {
        for (const text of positives) {
          const res = checkPolicy(text);
          expect(res.findings.map((x) => x.rule), text).toContain(rule);
          expect(res.risk, text).toBe("HIGH");
        }
        for (const text of negatives.filter(Boolean)) {
          const res = checkPolicy(text);
          expect(res.findings.map((x) => x.rule), text).not.toContain(rule);
        }
        expect(checkPolicy(f.good).risk).toBe("LOW");
        expect(checkPolicy(f.good).findings).toEqual([]);
      });
    }
    it("tenant banned phrase is MEDIUM risk (blocked-only warning), hard rules stay HIGH", () => {
      const banned = checkPolicy(f.banned, [f.banned]);
      expect(banned.findings.map((x) => x.rule)).toContain("clinic-restriction");
      expect(banned.risk).toBe("MEDIUM");
      expect(checkPolicy(f.good, [f.banned]).risk).toBe("LOW");
      expect(checkPolicy(f.guarantee[0]!, [f.banned]).risk).toBe("HIGH");
    });
  });
describe("Türkçe büyük harf ve yerel ayar", () => {
  it("İ/I iki yönlü normalize edilir: kalıplar ve yasaklı ifadeler her iki küçük harf biçiminde denenir", () => {
    expect(checkPolicy("%100 GARANTİLİ SONUÇ").risk).toBe("HIGH");
    expect(checkPolicy("KESİN SONUÇ").findings.map((x) => x.rule)).toContain("guarantee");
    expect(checkPolicy("SAÇLARINIZ DÖKÜLÜYOR MU?").findings.map((x) => x.rule)).toContain("personal-attribute");
    // Yasaklı ifade "ivf"/"implant": metin büyük harf (I → tr yerelinde "ı" olur; varsayılan yerelde "i").
    expect(checkPolicy("IVF tedavisi hakkında", ["ivf"]).risk).toBe("MEDIUM");
    expect(checkPolicy("Implant fiyatları", ["implant"]).risk).toBe("MEDIUM");
    // Ters yön: yasaklı ifade büyük harf, metin küçük harf.
    expect(checkPolicy("ivf tedavisi", ["IVF"]).risk).toBe("MEDIUM");
    expect(checkPolicy("İmplant tedavisi", ["implant"]).risk).toBe("MEDIUM");
    expect(checkPolicy("Diş tedavisi", ["ivf", "implant"]).risk).toBe("LOW");
  });
  it("kelime içi eşleşme yapmaz (Unicode kelime sınırı)", () => {
    expect(checkPolicy("voornaam").findings).toEqual([]);
    expect(checkPolicy("voornamelijk").findings).toEqual([]);
    expect(checkPolicy("przedpołudniowe").findings).toEqual([]);
    expect(checkPolicy("Ungarn garantiert nichts").findings.map((x) => x.rule)).toContain("guarantee");
    expect(checkPolicy("Bulgaristan").findings).toEqual([]);
  });
});
it("normalizes invisible characters and ignores blank restrictions", () => {
  expect(checkPolicy("guaran​teed").risk).toBe("HIGH");
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
  expect(batch.version).toBe(POLICY_VERSION);
  expect(batch.results.find((r) => r.id === "a")?.risk).toBe("LOW");
  expect(batch.results.find((r) => r.id === "b")?.risk).toBe("HIGH");
  expect(batch.results.find((r) => r.id === "c")?.risk).toBe("MEDIUM");
});
it("uses supplied rules and reports engine version + rule key/version/active (ADR-0008); disabled and unmatched rules are annotated", () => {
  const phraseRule = {
    key: "vip-claim", version: 3, matcher: "PHRASES_V1" as const,
    phrases: ["%100 garanti", "kesin çözüm"],
    risk: "HIGH" as const, reason: "Sert iddia", suggestion: "Süreci anlatın", active: true,
  };
  const disabled = { ...DEFAULT_POLICY_RULES[0]!, active: false };
  const res = checkPolicy("Kesin çözüm vaat ediyoruz", [], [phraseRule, disabled]);
  expect(res.version).toBe(POLICY_VERSION);
  expect(res.findings).toHaveLength(1);
  expect(res.findings[0]?.rule).toBe("vip-claim");
  expect(res.findings[0]?.ruleVersion).toBe(3);
  expect(res.risk).toBe("HIGH");
  expect(res.ruleVersions).toContainEqual({ key: "vip-claim", version: 3, active: true });
  expect(res.ruleVersions).toContainEqual({ key: "guarantee", version: 1, active: false });
  const clean = checkPolicy("Contact our team", [], [phraseRule, disabled]);
  expect(clean.risk).toBe("LOW");
  expect(clean.findings).toEqual([]);
  expect(clean.ruleVersions).toHaveLength(2);
  // Büyük harfli kural ifadesi ve metin de eşleşir.
  expect(checkPolicy("KESİN ÇÖZÜM VAAT EDİYORUZ", [], [phraseRule]).risk).toBe("HIGH");
});
