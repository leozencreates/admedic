import {
  LEAD_TEAM_PROMPT_VERSION,
  directorSystemPrompt,
  extractJson,
  specialistSystemPrompt,
  teamLeadSystemPrompt,
  type LlmUsage,
} from "@admedic/llm";
import type { z } from "zod";

import { DIRECTOR, TEAMS, TEAM_SIZE, leadOf, specialistsOf, type AgentDef, type TeamDef } from "./roster";
import {
  DirectorOutputSchema,
  LeadOutputSchema,
  SpecialistOutputSchema,
  type DirectorOutput,
  type LeadOutput,
  type SpecialistOutput,
} from "./schemas";

/**
 * Lead takımı çalıştırması (ADR-0029). Saf orkestrasyon: veritabanı ve ağ yok; LLM çağrısı ve rapor kaydı
 * çağıran tarafından verilir. Sıra: 42 uzman (sınırlı eşzamanlılık) → 7 takım lideri → direktör.
 * Bir uzmanın hatası takımı durdurmaz; lider elindeki raporlarla çalışır. Direktör hiçbir lider raporu yoksa
 * ya da kendisi başarısız olursa çalıştırma başarısız sayılır.
 */

/** Kişisel veri içermeyen bağlam; ajanlara JSON olarak verilir. */
export interface LeadTeamContext {
  currency: string;
  /** Aylık üst sınır ve aktif kampanyaların aylık toplamı (major birim); sınır yoksa null. */
  monthlyCap: number | null;
  monthlyCommitted: number;
  clinic: {
    name: string;
    city: string | null;
    languages: string[];
    targetMarket: string;
    accreditations: string[];
    brandTone: string | null;
    bannedPhrases: string[];
    services: Array<{ name: string; category: string; durationDays: number | null; packageIncludes: string[] }>;
    marketTargets: Array<{ country: string; language: string; demand: number }>;
  } | null;
  /** Son 30 günün kampanya sonuçları (toplam; major birim). */
  campaigns: Array<{ name: string; status: string; dailyBudget: number | null; spend: number; leads: number; clicks: number }>;
  /** Lead hunisi: yalnızca sayılar. */
  leads: {
    byStatus: Record<string, number>;
    byLanguage: Record<string, number>;
    byChannel: Record<string, number>;
    lostReasons: Array<{ reason: string; count: number }>;
  };
}

export interface AgentCall {
  agent: AgentDef;
  system: string;
  user: string;
  maxTokens: number;
}

export interface AgentReport {
  agent: AgentDef;
  status: "COMPLETED" | "FAILED";
  output: SpecialistOutput | LeadOutput | DirectorOutput | null;
  usage: LlmUsage;
}

export interface LeadTeamDeps {
  /** Tek LLM çağrısı; metin (JSON beklenir) ve token kullanımı döner. */
  call: (call: AgentCall) => Promise<{ text: string; usage: LlmUsage }>;
  /** Her ajan bittiğinde çağrılır (ilerleme ve kalıcı kayıt). */
  onReport?: (report: AgentReport) => Promise<void>;
  /** Aynı anda çalışan uzman sayısı. */
  concurrency?: number;
}

export interface LeadTeamResult {
  status: "COMPLETED" | "FAILED";
  decision: DirectorOutput | null;
  reports: AgentReport[];
  usage: LlmUsage;
  /** Başarısızlık nedeni (kullanıcıya gösterilebilir). */
  error: string | null;
}

export { LEAD_TEAM_PROMPT_VERSION, TEAM_SIZE };

export const DEFAULT_CONCURRENCY = 6;
/** Geçersiz JSON ya da çağrı hatasında ajan başına toplam deneme. */
const ATTEMPTS = 2;
const MAX_TOKENS: Record<AgentDef["role"], number> = { SPECIALIST: 700, LEAD: 900, DIRECTOR: 1400 };

async function runAgent<S extends z.ZodTypeAny>(
  deps: LeadTeamDeps,
  agent: AgentDef,
  system: string,
  payload: unknown,
  schema: S,
): Promise<AgentReport & { output: z.output<S> | null }> {
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let output: z.output<S> | null = null;
  for (let attempt = 0; attempt < ATTEMPTS && output === null; attempt++) {
    try {
      const reply = await deps.call({ agent, system, user: JSON.stringify(payload), maxTokens: MAX_TOKENS[agent.role] });
      usage.inputTokens += reply.usage.inputTokens;
      usage.outputTokens += reply.usage.outputTokens;
      const parsed = schema.safeParse(extractJson(reply.text));
      if (parsed.success) output = parsed.data;
    } catch {
      // Çağrı ya da JSON hatası: kalan deneme varsa yeniden denenir.
    }
  }
  const report = { agent, status: output === null ? ("FAILED" as const) : ("COMPLETED" as const), output, usage };
  await deps.onReport?.(report);
  return report;
}

/** Sınırlı eşzamanlılıkla sıralı sonuç döndüren havuz. */
async function pool<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]!);
      }
    }),
  );
  return results;
}

export async function runLeadTeam(context: LeadTeamContext, deps: LeadTeamDeps): Promise<LeadTeamResult> {
  const reports: AgentReport[] = [];
  const teamOf = new Map<string, TeamDef>(TEAMS.map((team) => [team.key, team]));

  // 1) Uzmanlar
  const specialists = TEAMS.flatMap(specialistsOf);
  const specialistReports = await pool(specialists, deps.concurrency ?? DEFAULT_CONCURRENCY, (agent) =>
    runAgent(
      deps,
      agent,
      specialistSystemPrompt({ title: agent.title, focus: agent.focus, teamTitle: teamOf.get(agent.team!)!.title }),
      { context },
      SpecialistOutputSchema,
    ),
  );
  reports.push(...specialistReports);

  // 2) Takım liderleri: yalnızca kendi uzmanlarının başarılı raporlarını görür.
  const leadReports = await Promise.all(
    TEAMS.map(async (team) => {
      const lead = leadOf(team);
      const inputs = specialistReports
        .filter((report) => report.agent.team === team.key && report.output !== null)
        .map((report) => ({ specialist: report.agent.title, ...report.output! }));
      if (inputs.length === 0) {
        const skipped: AgentReport & { output: LeadOutput | null } = {
          agent: lead,
          status: "FAILED",
          output: null,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        await deps.onReport?.(skipped);
        return skipped;
      }
      return runAgent(deps, lead, teamLeadSystemPrompt({ title: team.title, mission: team.mission }), { context, specialistReports: inputs }, LeadOutputSchema);
    }),
  );
  reports.push(...leadReports);

  const usage = () =>
    reports.reduce<LlmUsage>(
      (sum, report) => ({ inputTokens: sum.inputTokens + report.usage.inputTokens, outputTokens: sum.outputTokens + report.usage.outputTokens }),
      { inputTokens: 0, outputTokens: 0 },
    );

  // 3) Direktör: nihai karar.
  const leadInputs = leadReports
    .filter((report) => report.output !== null)
    .map((report) => ({ team: report.agent.team, teamTitle: teamOf.get(report.agent.team!)!.title, ...report.output! }));
  if (leadInputs.length === 0) {
    const skipped: AgentReport = { agent: DIRECTOR, status: "FAILED", output: null, usage: { inputTokens: 0, outputTokens: 0 } };
    await deps.onReport?.(skipped);
    reports.push(skipped);
    return { status: "FAILED", decision: null, reports, usage: usage(), error: "Hiçbir takım rapor üretemedi; direktör karar veremedi." };
  }
  const director = await runAgent(deps, DIRECTOR, directorSystemPrompt(), { context, teamReports: leadInputs }, DirectorOutputSchema);
  reports.push(director);
  if (director.output === null)
    return { status: "FAILED", decision: null, reports, usage: usage(), error: "Direktör geçerli bir karar üretemedi." };
  return { status: "COMPLETED", decision: director.output, reports, usage: usage(), error: null };
}
