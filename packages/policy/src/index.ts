export const POLICY_VERSION = "studio-policy-2";
export type PolicyRisk = "LOW" | "MEDIUM" | "HIGH";
export type Finding = { rule: string; reason: string; suggestion: string };
export type PolicyResult = {
  version: string;
  risk: PolicyRisk;
  findings: Finding[];
};

const HARD_RULES = [
  {
    id: "guarantee",
    pattern: /garanti|kesin sonuç|guarantee|guaranteed|garantiert|гарант|مضمون|مضمونة/iu,
    reason: "Kesin sonuç veya garanti ifadesi.",
    suggestion: "Sonuç vaadi yerine hizmet ve görüşme sürecini anlatın.",
  },
  {
    id: "before-after",
    pattern:
      /önce\s*[/–—-]?\s*sonra|before\s*(?:and|&|[/–—-])?\s*after|vorher\s*(?:und|&|[/–—-])?\s*nachher|до\s*(?:и|[/–—-])?\s*после|قبل\s*(?:و|[/–—-])?\s*بعد/iu,
    reason: "Önce/sonra karşılaştırması.",
    suggestion: "Karşılaştırmayı kaldırıp tarafsız hizmet bilgisi kullanın.",
  },
  {
    id: "personal-attribute",
    pattern:
      /(?:saçların(?:ız)? dökül|dişlerin(?:iz)? eksik|kel misin|are you bald|your missing teeth|sind sie kahl|ihre fehlenden zähne|вы лыс|ваши отсутствующие зубы|هل أنت أصلع|أسنانك المفقودة)/iu,
    reason: "Okuyucunun sağlık veya görünüş özelliği varsayılıyor.",
    suggestion:
      "Kişiye özellik atfetmek yerine hizmeti genel ifadelerle tanıtın.",
  },
];

function normalize(text: string) {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

export function checkPolicy(
  text: string,
  bannedPhrases: string[] = [],
): PolicyResult {
  const normalized = normalize(text);
  const findings: Finding[] = HARD_RULES.filter((r) =>
    r.pattern.test(normalized),
  ).map((r) => ({
    rule: r.id,
    reason: r.reason,
    suggestion: r.suggestion,
  }));
  if (
    bannedPhrases.some(
      (s) =>
        s.trim() &&
        normalized
          .toLocaleLowerCase("tr")
          .includes(s.normalize("NFKC").trim().toLocaleLowerCase("tr")),
    )
  ) {
    findings.push({
      rule: "clinic-restriction",
      reason: "Klinik tarafından yasaklanan ifade bulundu.",
      suggestion:
        "Klinik içerik kısıtlarını karşılayacak şekilde yeniden yazın.",
    });
  }
  const hasHard = findings.some((f) =>
    HARD_RULES.some((r) => r.id === f.rule),
  );
  const risk: PolicyRisk = hasHard ? "HIGH" : findings.length ? "MEDIUM" : "LOW";
  return { version: POLICY_VERSION, risk, findings };
}

export type PolicyCheckItem = { id: string; text: string };
export function checkPolicyBatch(
  items: PolicyCheckItem[],
  bannedPhrases: string[] = [],
) {
  const results = items.map((item) => ({
    id: item.id,
    ...checkPolicy(item.text, bannedPhrases),
  }));
  return {
    version: POLICY_VERSION,
    results,
    risk: results.some((r) => r.risk === "HIGH")
      ? ("HIGH" as const)
      : results.some((r) => r.risk === "MEDIUM")
        ? ("MEDIUM" as const)
        : ("LOW" as const),
  };
}