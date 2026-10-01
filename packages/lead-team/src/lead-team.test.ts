import { describe, expect, it, vi } from "vitest";

import { LEAD_TEAM_RULES } from "@admedic/llm";
import { DIRECTOR, ROSTER, TEAMS, TEAM_SIZE } from "./roster";
import { runLeadTeam, type AgentCall, type AgentReport, type LeadTeamContext } from "./run";
import { DirectorOutputSchema, MAX_DAILY_BUDGET, ProposalSchema, SpecialistOutputSchema } from "./schemas";
import { simulateAgentReply } from "./simulate";

const context: LeadTeamContext = {
  currency: "EUR",
  monthlyCap: 3000,
  monthlyCommitted: 900,
  clinic: {
    name: "Örnek Klinik",
    city: "İstanbul",
    languages: ["TR", "DE"],
    targetMarket: "GERMANY",
    accreditations: ["JCI"],
    brandTone: null,
    bannedPhrases: [],
    services: [{ name: "Saç ekimi", category: "MEDICAL", durationDays: 3, packageIncludes: ["otel"] }],
    marketTargets: [{ country: "DE", language: "DE", demand: 0.7 }],
  },
  campaigns: [],
  leads: { byStatus: {}, byLanguage: {}, byChannel: {}, lostReasons: [] },
};

const usage = { inputTokens: 10, outputTokens: 5 };
const simulated = async (call: AgentCall) => ({ text: simulateAgentReply(call), usage });

describe("kadro", () => {
  it("50 ajan: 1 direktör, 7 lider, 42 uzman; anahtarlar benzersiz ve her uzman bir takıma bağlı", () => {
    expect(TEAM_SIZE).toBe(50);
    expect(ROSTER.filter((a) => a.role === "DIRECTOR")).toEqual([DIRECTOR]);
    expect(ROSTER.filter((a) => a.role === "LEAD")).toHaveLength(7);
    expect(ROSTER.filter((a) => a.role === "SPECIALIST")).toHaveLength(42);
    expect(new Set(ROSTER.map((a) => a.key)).size).toBe(50);
    const teamKeys = new Set(TEAMS.map((t) => t.key));
    for (const agent of ROSTER) {
      if (agent.role === "DIRECTOR") expect(agent.team).toBeNull();
      else expect(teamKeys.has(agent.team!)).toBe(true);
    }
  });

  it("ortak kurallar gizli hesap, gruplara katılma ve insan onayını açıkça yazar", () => {
    expect(LEAD_TEAM_RULES).toContain("fake or covert accounts");
    expect(LEAD_TEAM_RULES).toContain("joining groups");
    expect(LEAD_TEAM_RULES).toContain("A human reviews and approves every proposal");
    expect(LEAD_TEAM_RULES).toContain("no before/after");
  });
});

describe("çıktı şemaları", () => {
  it("bilinmeyen pazar/dil null olur, metin kısaltılır, geçersiz bütçe yok sayılır", () => {
    const proposal = ProposalSchema.parse({
      title: "  Almanya   lead formu ",
      market: "germany",
      language: "xx",
      service: "",
      angle: "a".repeat(500),
      dailyBudget: MAX_DAILY_BUDGET + 1,
      rationale: "çünkü",
    });
    expect(proposal).toMatchObject({ title: "Almanya lead formu", market: "GERMANY", language: null, service: null, dailyBudget: null });
    expect(proposal.angle).toHaveLength(300);
    expect(ProposalSchema.parse({ title: "t", angle: "a", rationale: "r", dailyBudget: -5 }).dailyBudget).toBeNull();
    expect(ProposalSchema.safeParse({ title: "", angle: "a", rationale: "r" }).success).toBe(false);
  });

  it("geçersiz öğeler atılır ve sınırlar uygulanır", () => {
    const ok = { title: "t", angle: "a", rationale: "r" };
    const specialist = SpecialistOutputSchema.parse({ findings: ["1", 2, "3", "4", "5"], proposals: [ok, { title: "eksik" }, ok, ok], confidence: 7 });
    expect(specialist.findings).toEqual(["1", "3", "4"]);
    expect(specialist.proposals).toHaveLength(2);
    expect(specialist.confidence).toBe(1);
    const director = DirectorOutputSchema.parse({ decision: "karar", proposals: Array.from({ length: 8 }, () => ({ ...ok, priority: "urgent" })) });
    expect(director.proposals).toHaveLength(5);
    expect(director.proposals[0]).toMatchObject({ priority: "MEDIUM", sourceTeams: [] });
    expect(director.rejected).toEqual([]);
    expect(DirectorOutputSchema.safeParse({ proposals: [] }).success).toBe(false);
  });
});

describe("çalıştırma", () => {
  it("50 ajan sırayla çalışır: uzmanlar → liderler → direktör; nihai karar direktörden gelir", async () => {
    const order: string[] = [];
    const reports: AgentReport[] = [];
    const call = vi.fn(async (c: AgentCall) => {
      order.push(c.agent.role);
      return simulated(c);
    });
    const result = await runLeadTeam(context, { call, onReport: async (r) => void reports.push(r) });

    expect(result.status).toBe("COMPLETED");
    expect(call).toHaveBeenCalledTimes(50);
    expect(reports).toHaveLength(50);
    expect(result.reports.every((r) => r.status === "COMPLETED")).toBe(true);
    // Hiyerarşi: hiçbir lider ilk uzman bitmeden, direktör son liderden önce çalışmaz.
    expect(order.lastIndexOf("SPECIALIST")).toBeLessThan(order.indexOf("LEAD"));
    expect(order.lastIndexOf("LEAD")).toBeLessThan(order.indexOf("DIRECTOR"));
    expect(order.filter((r) => r === "DIRECTOR")).toHaveLength(1);
    expect(result.decision!.proposals.length).toBeGreaterThan(0);
    expect(result.decision!.proposals.length).toBeLessThanOrEqual(5);
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 250 });

    // Lider yalnızca kendi takımının raporlarını görür; direktör yedi takımı görür.
    const marketLead = call.mock.calls.find(([c]) => c.agent.key === "lead:market")![0];
    const seen = JSON.parse(marketLead.user).specialistReports.map((r: { specialist: string }) => r.specialist);
    expect(seen).toEqual(TEAMS[0]!.specialists.map((s) => s.title));
    const director = call.mock.calls.find(([c]) => c.agent.key === "director")![0];
    expect(JSON.parse(director.user).teamReports.map((r: { team: string }) => r.team)).toEqual(TEAMS.map((t) => t.key));
    expect(director.system).toContain("final decision");
  });

  it("eşzamanlılık sınırını aşmaz", async () => {
    let active = 0;
    let peak = 0;
    const call = async (c: AgentCall) => {
      if (c.agent.role === "SPECIALIST") {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
      }
      return simulated(c);
    };
    await runLeadTeam(context, { call, concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("bir uzmanın hatası takımı durdurmaz; geçersiz JSON bir kez yeniden denenir", async () => {
    const attempts = new Map<string, number>();
    const call = async (c: AgentCall) => {
      const n = (attempts.get(c.agent.key) ?? 0) + 1;
      attempts.set(c.agent.key, n);
      if (c.agent.key === "market:germany") throw new Error("boom");
      if (c.agent.key === "market:uk" && n === 1) return { text: "üzgünüm, JSON değil", usage };
      return simulated(c);
    };
    const result = await runLeadTeam(context, { call });
    expect(result.status).toBe("COMPLETED");
    expect(attempts.get("market:germany")).toBe(2);
    expect(attempts.get("market:uk")).toBe(2);
    const byKey = new Map(result.reports.map((r) => [r.agent.key, r]));
    expect(byKey.get("market:germany")!.status).toBe("FAILED");
    expect(byKey.get("market:uk")!.status).toBe("COMPLETED");
    expect(byKey.get("market:uk")!.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(byKey.get("lead:market")!.status).toBe("COMPLETED");
  });

  it("takımın bütün uzmanları başarısızsa lider çağrılmaz; direktör kalan takımlarla karar verir", async () => {
    const call = vi.fn(async (c: AgentCall) => {
      if (c.agent.team === "budget" && c.agent.role === "SPECIALIST") throw new Error("down");
      return simulated(c);
    });
    const result = await runLeadTeam(context, { call });
    expect(result.status).toBe("COMPLETED");
    expect(call.mock.calls.some(([c]) => c.agent.key === "lead:budget")).toBe(false);
    expect(result.reports.find((r) => r.agent.key === "lead:budget")!.status).toBe("FAILED");
    const director = call.mock.calls.find(([c]) => c.agent.key === "director")![0];
    expect(JSON.parse(director.user).teamReports).toHaveLength(6);
  });

  it("hiçbir takım rapor üretemezse ya da direktör başarısızsa çalıştırma başarısızdır", async () => {
    const allDown = await runLeadTeam(context, { call: async () => Promise.reject(new Error("down")) });
    expect(allDown).toMatchObject({ status: "FAILED", decision: null });
    expect(allDown.error).toContain("Hiçbir takım");
    expect(allDown.reports).toHaveLength(50);

    const directorDown = await runLeadTeam(context, {
      call: async (c) => (c.agent.role === "DIRECTOR" ? { text: "{}", usage } : simulated(c)),
    });
    expect(directorDown).toMatchObject({ status: "FAILED", decision: null });
    expect(directorDown.error).toContain("Direktör");
  });
});
