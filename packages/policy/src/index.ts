export const POLICY_VERSION = "studio-policy-3";
export type PolicyRisk = "LOW" | "MEDIUM" | "HIGH";
export type PolicyMatcher = "GUARANTEE_V1" | "BEFORE_AFTER_V1" | "PERSONAL_ATTRIBUTE_V1" | "PHRASES_V1";
export type PolicyRuleDefinition = {
  key: string;
  version: number;
  matcher: PolicyMatcher;
  phrases: string[];
  risk: PolicyRisk;
  reason: string;
  suggestion: string;
  active: boolean;
};
export type Finding = { rule: string; reason: string; suggestion: string; risk?: PolicyRisk; ruleVersion?: number };
export type PolicyResult = {
  version: string;
  risk: PolicyRisk;
  findings: Finding[];
  ruleVersions: { key: string; version: number; active: boolean }[];
};

const HARD_RULES = [
  {
    id: "guarantee",
    pattern: /garanti|kesin sonuç|guarantee|guaranteed|garantiert|гарант|مضمون|مضمونة|garantie|gegarandeerd|gwarancj|gwarantowan/iu,
    reason: "Kesin sonuç veya garanti ifadesi.",
    suggestion: "Sonuç vaadi yerine hizmet ve görüşme sürecini anlatın.",
  },
  {
    id: "before-after",
    pattern:
      /önce\s*[/–—-]?\s*sonra|before\s*(?:and|&|[/–—-])?\s*after|vorher\s*(?:und|&|[/–—-])?\s*nachher|до\s*(?:и|[/–—-])?\s*после|قبل\s*(?:و|[/–—-])?\s*بعد|avant\s*(?:et|&|[/–—-])?\s*après|voor\s*(?:en|&|[/–—-])?\s*na|przed\s*(?:i|&|[/–—-])?\s*po/iu,
    reason: "Önce/sonra karşılaştırması.",
    suggestion: "Karşılaştırmayı kaldırıp tarafsız hizmet bilgisi kullanın.",
  },
  {
    id: "personal-attribute",
    pattern:
      /(?:saçların(?:ız)? dökül|dişlerin(?:iz)? eksik|kel misin|are you bald|your missing teeth|sind sie kahl|ihre fehlenden zähne|вы лыс|ваши отсутствующие зубы|هل أنت أصلع|أسنانك المفقودة|êtes-vous chauve|vos dents manquantes|bent u kaal|uw ontbrekende tanden|czy jesteś łysy|brakujące zęby)/iu,
    reason: "Okuyucunun sağlık veya görünüş özelliği varsayılıyor.",
    suggestion:
      "Kişiye özellik atfetmek yerine hizmeti genel ifadelerle tanıtın.",
  },
];

const MATCHERS = {
  GUARANTEE_V1: HARD_RULES[0]!.pattern,
  BEFORE_AFTER_V1: HARD_RULES[1]!.pattern,
  PERSONAL_ATTRIBUTE_V1: HARD_RULES[2]!.pattern,
};
export const DEFAULT_POLICY_RULES: PolicyRuleDefinition[] = HARD_RULES.map((rule, i) => ({
  key: rule.id, version: 1,
  matcher: (["GUARANTEE_V1", "BEFORE_AFTER_V1", "PERSONAL_ATTRIBUTE_V1"] as const)[i]!,
  phrases: [], risk: "HIGH", reason: rule.reason, suggestion: rule.suggestion, active: true,
}));

function normalize(text: string) {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

export function checkPolicy(
  text: string,
  bannedPhrases: string[] = [],
  rules: readonly PolicyRuleDefinition[] = DEFAULT_POLICY_RULES,
): PolicyResult {
  const normalized = normalize(text);
  const containsPhrase = (phrase: string) => Boolean(phrase.trim()) &&
    normalized.toLocaleLowerCase("tr").includes(normalize(phrase).trim().toLocaleLowerCase("tr"));
  const findings: Finding[] = rules.filter((r) => r.active && (
    r.matcher === "PHRASES_V1" ? r.phrases.some(containsPhrase) : MATCHERS[r.matcher].test(normalized)
  )).map((r) => ({
    rule: r.key,
    ruleVersion: r.version,
    risk: r.risk,
    reason: r.reason,
    suggestion: r.suggestion,
  }));
  if (
    bannedPhrases.some(containsPhrase)
  ) {
    findings.push({
      rule: "clinic-restriction",
      risk: "MEDIUM",
      reason: "Klinik tarafından yasaklanan ifade bulundu.",
      suggestion:
        "Klinik içerik kısıtlarını karşılayacak şekilde yeniden yazın.",
    });
  }
  const risk: PolicyRisk = findings.some((f) => f.risk === "HIGH") ? "HIGH"
    : findings.some((f) => f.risk === "MEDIUM") ? "MEDIUM" : "LOW";
  return { version: POLICY_VERSION, risk, findings,
    ruleVersions: rules.map(({ key, version, active }) => ({ key, version, active })),
  };
}

export type PolicyCheckItem = { id: string; text: string };
export function checkPolicyBatch(
  items: PolicyCheckItem[],
  bannedPhrases: string[] = [],
  rules: readonly PolicyRuleDefinition[] = DEFAULT_POLICY_RULES,
) {
  const results = items.map((item) => ({
    id: item.id,
    ...checkPolicy(item.text, bannedPhrases, rules),
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
