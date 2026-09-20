export const POLICY_VERSION = "studio-policy-1";
export type Finding = { rule: string; reason: string; suggestion: string };
const rules = [
  {
    id: "guarantee",
    pattern: /garanti|kesin sonuç|guarantee|garantiert|гарант|مضمون|مضمونة/iu,
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

export function checkPolicy(text: string, bannedPhrases: string[] = []) {
  const normalized = text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
  const findings: Finding[] = rules
    .filter((r) => r.pattern.test(normalized))
    .map((r) => ({ rule: r.id, reason: r.reason, suggestion: r.suggestion }));
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
  return {
    version: POLICY_VERSION,
    risk: findings.length ? ("HIGH" as const) : ("LOW" as const),
    findings,
  };
}
