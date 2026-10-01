import type { AgentCall, LeadTeamContext } from "./run";

/**
 * Deneme çıktısı (ADR-0029): deneme modunda ve LLM ayarsızken yapay zekâ yerine kullanılır. Hiyerarşinin ve
 * onay akışının uçtan uca denenebilmesi içindir; içerik bağlamdan türetilen sabit kalıplardır, analiz değildir.
 * Çalıştırma `simulated` olarak işaretlenir ve panel bunu açıkça gösterir.
 */

const MARKET_OF: Record<string, string> = {
  turkey: "TURKEY",
  germany: "GERMANY",
  uk: "UK",
  netherlands: "NETHERLANDS",
  usa: "USA",
  gulf: "GULF",
  other: "OTHER",
};
const LANGUAGES = ["TR", "EN", "DE", "RU", "AR", "FR", "NL", "PL"];

interface SimProposal {
  title: string;
  market: string | null;
  language: string | null;
  service: string | null;
  angle: string;
  dailyBudget: number | null;
  rationale: string;
}

function proposalsIn(reports: unknown): SimProposal[] {
  if (!Array.isArray(reports)) return [];
  return reports.flatMap((report) => {
    const proposals = (report as { proposals?: unknown }).proposals;
    return Array.isArray(proposals) ? (proposals as SimProposal[]) : [];
  });
}

export function simulateAgentReply(call: AgentCall): string {
  const payload = JSON.parse(call.user) as { context: LeadTeamContext; specialistReports?: unknown; teamReports?: unknown };
  const { agent } = call;
  const clinic = payload.context.clinic;

  if (agent.role === "SPECIALIST") {
    const [, slug = ""] = agent.key.split(":");
    const language = LANGUAGES.includes(slug.toUpperCase()) ? slug.toUpperCase() : (clinic?.languages[0] ?? null);
    const market = MARKET_OF[slug] ?? clinic?.targetMarket ?? null;
    const service = clinic?.services[0]?.name ?? null;
    return JSON.stringify({
      findings: [`Deneme çıktısı: "${agent.title}" uzmanı için yapay zekâ çağrılmadı.`],
      proposals: [
        {
          title: `${agent.title}: deneme önerisi`,
          market,
          language,
          service,
          angle: "Süreci adım adım anlatan, vaat içermeyen bilgilendirici mesaj.",
          dailyBudget: 20,
          rationale: "Deneme modu: bu öneri bağlamdan kalıpla üretildi, analiz sonucu değildir.",
        },
      ],
      confidence: 0.5,
    });
  }

  if (agent.role === "LEAD") {
    return JSON.stringify({
      summary: `Deneme çıktısı: "${agent.title}" uzman raporlarını birleştirdi.`,
      proposals: proposalsIn(payload.specialistReports).slice(0, 3),
      risks: ["Deneme modu: riskler değerlendirilmedi."],
    });
  }

  const teams = Array.isArray(payload.teamReports) ? (payload.teamReports as Array<{ team?: string; proposals?: SimProposal[] }>) : [];
  return JSON.stringify({
    decision: "Deneme çıktısı: direktör her takımın ilk önerisini sırayla seçti. Yapay zekâ çağrılmadı.",
    proposals: teams
      .filter((team) => Array.isArray(team.proposals) && team.proposals.length > 0)
      .slice(0, 5)
      .map((team, index) => ({ ...team.proposals![0]!, priority: index === 0 ? "HIGH" : "MEDIUM", sourceTeams: [team.team ?? ""] })),
    rejected: [],
  });
}
