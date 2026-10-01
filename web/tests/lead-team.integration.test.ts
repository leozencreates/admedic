import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { loadEnv } from "@admedic/config";
import { prisma, type Role } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (key: string) => (cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined) }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { GET as overview, POST as runTeam } from "../app/api/lead-team/route";
import { POST as decide } from "../app/api/lead-team/proposals/[id]/route";
import { DAILY_RUN_LIMIT, STALE_RUN_MS, executeLeadTeamRun, startLeadTeamRun } from "../app/_lib/lead-team";
import { countPendingApprovals, listPendingApprovals } from "../app/_lib/pending-approvals";

const ORIGIN = "http://localhost:3000";
function req(url: string, method: string, bodyObj?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { origin, ...(bodyObj === undefined ? {} : { "content-type": "application/json" }) },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * Lead takımı (ADR-0029): 50 ajan çalışır, direktörün önerileri insan onayını bekler. Ajanlara kişisel veri
 * gitmez; onay kampanya oluşturmaz.
 */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("lead takımı: çalıştırma → direktör kararı → insan onayı", () => {
  const suffix = randomBytes(8).toString("hex");
  const users: string[] = [];
  const orgs: string[] = [];
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let orgId = "";
  let workspaceId = "";
  let foreignWorkspaceId = "";

  const as = (role: string) => cookieJar.set(SESSION_COOKIE, tokens[role]!);
  const mockMode = (mock: boolean) => loadEnv({ fresh: true, overrides: { META_MOCK_MODE: String(mock) } });

  beforeAll(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("LLM_MODEL", "");
    mockMode(true);
    for (const foreign of [false, true]) {
      const org = await prisma.organization.create({
        data: {
          name: "Lead team fixture",
          slug: `lead-team-${suffix}-${foreign}`,
          monthlyAdBudgetCap: 300_000,
          workspaces: { create: { name: "W", slug: "w", currency: "EUR" } },
        },
        include: { workspaces: true },
      });
      orgs.push(org.id);
      const wsId = org.workspaces[0]!.id;
      for (const role of (foreign ? ["OWNER"] : ["OWNER", "MEDIA_BUYER", "ANALYST", "VIEWER"]) as Role[]) {
        const user = await prisma.user.create({ data: { email: `${suffix}-${foreign}-${role}@example.invalid`, name: `Kullanıcı ${role}` } });
        users.push(user.id);
        await prisma.membership.create({ data: { orgId: org.id, userId: user.id, role } });
        const token = randomBytes(32).toString("hex");
        await prisma.webSession.create({ data: { tokenHash: tokenHash(token), userId: user.id, workspaceId: wsId, expiresAt: new Date(Date.now() + 600_000) } });
        tokens[foreign ? "FOREIGN" : role] = token;
        userIds[foreign ? "FOREIGN" : role] = user.id;
      }
      if (foreign) {
        foreignWorkspaceId = wsId;
        continue;
      }
      orgId = org.id;
      workspaceId = wsId;
      await prisma.clinicProfile.create({
        data: {
          workspaceId: wsId,
          name: "Örnek Klinik",
          slug: `lead-team-${suffix}`,
          languages: ["TR", "DE"],
          targetMarket: "GERMANY",
          accreditations: ["JCI"],
          services: { create: { name: "Saç ekimi", slug: "sac-ekimi", category: "MEDICAL", durationDays: 3 } },
          marketTargets: { create: { country: "DE", language: "DE", demand: 0.8 } },
        },
      });
      const account = await prisma.adAccount.create({ data: { orgId: org.id, workspaceId: wsId, name: "Hesap", currency: "EUR" } });
      const campaign = await prisma.campaign.create({ data: { adAccountId: account.id, workspaceId: wsId, name: "Almanya lead formu", dailyBudget: 5000 } });
      await prisma.insightSnapshot.create({ data: { workspaceId: wsId, campaignId: campaign.id, date: new Date(), spend: 12_300, leads: 7, clicks: 210 } });
      await prisma.lead.createMany({
        data: [
          { workspaceId: wsId, organizationId: org.id, firstName: "Hildegard", lastName: "Musterfrau", language: "de", channel: "LEAD_AD", status: "NEW" },
          {
            workspaceId: wsId, organizationId: org.id, firstName: "Zeynep", lastName: "Gizlisoyad", language: "tr", channel: "INSTAGRAM",
            status: "LOST", lostReason: "Fiyat — eşi karşı çıktı, 0532 111 22 33",
          },
          { workspaceId: wsId, organizationId: org.id, firstName: "Anon", lastName: "X", language: "tr", status: "LOST", lostReason: "Diğer: özel bir not" },
        ],
      });
    }
  });
  beforeEach(async () => {
    await prisma.leadTeamRun.deleteMany({ where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } } });
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("LLM_MODEL", "");
    mockMode(true);
  });
  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    vi.unstubAllEnvs();
    loadEnv({ fresh: true });
    await prisma.$disconnect();
  });

  it("rol ve kaynak denetimi: izleyici göremez, analist çalıştıramaz, yabancı kaynak reddedilir", async () => {
    as("VIEWER");
    expect((await overview()).status).toBe(403);
    as("ANALYST");
    const view = await overview();
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({ canRun: false, canDecide: false, teamSize: 50, latest: null });
    expect((await runTeam(req("/api/lead-team", "POST", {}))).status).toBe(403);
    as("OWNER");
    expect((await runTeam(req("/api/lead-team", "POST", {}, "https://other.invalid"))).status).toBe(403);
    expect(await prisma.leadTeamRun.count({ where: { workspaceId } })).toBe(0);
  });

  it("deneme modunda 50 ajan çalışır; direktörün önerileri onay bekler ve Onaylar'a düşer", async () => {
    as("MEDIA_BUYER");
    const res = await runTeam(req("/api/lead-team", "POST", {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ run: { simulated: true } });

    const data = (await (await overview()).json()) as {
      latest: { status: string; simulated: boolean; agentsCompleted: number; agentsFailed: number; summary: string };
      reports: Array<{ agentKey: string; role: string; status: string }>;
      proposals: Array<{ id: string; status: string; rank: number; currency: string; dailyBudgetCents: number | null }>;
      canRun: boolean;
      canDecide: boolean;
    };
    expect(data.latest).toMatchObject({ status: "COMPLETED", simulated: true, agentsCompleted: 50, agentsFailed: 0 });
    expect(data.latest.summary).toContain("direktör");
    expect(data.reports).toHaveLength(50);
    expect(data.reports.filter((r) => r.role === "SPECIALIST")).toHaveLength(42);
    expect(data.reports.filter((r) => r.role === "LEAD")).toHaveLength(7);
    expect(data.reports.filter((r) => r.agentKey === "director")).toHaveLength(1);
    expect(data.proposals.length).toBeGreaterThan(0);
    expect(data.proposals.length).toBeLessThanOrEqual(5);
    expect(data.proposals.every((p) => p.status === "PENDING" && p.currency === "EUR")).toBe(true);
    expect(data.proposals.map((p) => p.rank)).toEqual(data.proposals.map((_, i) => i + 1));
    expect(data.proposals[0]!.dailyBudgetCents).toBe(2000);
    expect(data).toMatchObject({ canRun: true, canDecide: false });

    // Deneme modunda yapay zekâ çağrılmaz: çağrı günlüğü yazılmaz.
    expect(await prisma.llmCallLog.count({ where: { workspaceId, agent: { startsWith: "lead-team:" } } })).toBe(0);
    // Hiçbir kampanya oluşturulmadı ya da değiştirilmedi.
    expect(await prisma.campaign.count({ where: { workspaceId } })).toBe(1);

    expect((await countPendingApprovals(workspaceId)).byKind.LEAD_PROPOSAL).toBe(data.proposals.length);
    const { items } = await listPendingApprovals(workspaceId);
    expect(items.LEAD_PROPOSAL[0]).toMatchObject({ submittedBy: "Kullanıcı MEDIA_BUYER", submittedByLabel: "Takımı çalıştıran", href: "/lead-team" });
    expect(await prisma.auditLog.count({ where: { orgId, action: { in: ["LEAD_TEAM_RUN_STARTED", "LEAD_TEAM_RUN_COMPLETED"] } } })).toBe(2);
  });

  it("öneriye yalnızca hesap sahibi karar verir; ret gerekçe ister; karar bir kez verilir; başka çalışma alanı göremez", async () => {
    as("OWNER");
    await runTeam(req("/api/lead-team", "POST", {}));
    const proposals = await prisma.leadTeamProposal.findMany({ where: { workspaceId }, orderBy: { rank: "asc" } });
    const [first, second] = proposals;

    as("MEDIA_BUYER");
    expect((await decide(req("/x", "POST", { decision: "APPROVE" }), ctx(first!.id))).status).toBe(403);
    cookieJar.set(SESSION_COOKIE, tokens.FOREIGN!);
    expect((await decide(req("/x", "POST", { decision: "APPROVE" }), ctx(first!.id))).status).toBe(404);

    as("OWNER");
    expect((await decide(req("/x", "POST", { decision: "REJECT" }), ctx(first!.id))).status).toBe(422);
    expect((await decide(req("/x", "POST", { decision: "APPROVE" }), ctx(first!.id))).status).toBe(200);
    expect((await decide(req("/x", "POST", { decision: "REJECT", note: "geç" }), ctx(first!.id))).status).toBe(409);
    expect((await decide(req("/x", "POST", { decision: "REJECT", note: "Bütçe yok" }), ctx(second!.id))).status).toBe(200);

    expect(await prisma.leadTeamProposal.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({ status: "APPROVED", decidedById: userIds.OWNER });
    expect(await prisma.leadTeamProposal.findUniqueOrThrow({ where: { id: second!.id } })).toMatchObject({ status: "REJECTED", decisionNote: "Bütçe yok" });
    expect((await countPendingApprovals(workspaceId)).byKind.LEAD_PROPOSAL).toBe(proposals.length - 2);
    // Onay kampanya oluşturmaz.
    expect(await prisma.campaign.count({ where: { workspaceId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { orgId, action: "LEAD_TEAM_PROPOSAL_APPROVED", entityId: first!.id } })).toBe(1);
  });

  it("süren çalıştırma varken yenisi başlamaz; yarıda kalan kapatılır; günlük sınır uygulanır", async () => {
    const actor = { orgId, workspaceId, userId: userIds.OWNER! };
    const now = new Date();
    const running = await startLeadTeamRun(actor, now);
    await expect(startLeadTeamRun(actor, now)).rejects.toThrow(/şu an çalışıyor/);

    // Yarıda kalmış (sunucu yeniden başlamış) çalıştırma: süre dolunca kapatılır ve yenisi başlar.
    const later = new Date(now.getTime() + STALE_RUN_MS + 1000);
    const next = await startLeadTeamRun(actor, later);
    expect(await prisma.leadTeamRun.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({ status: "FAILED" });
    await executeLeadTeamRun(next.id);

    for (let i = 2; i < DAILY_RUN_LIMIT; i++) await executeLeadTeamRun((await startLeadTeamRun(actor, later)).id);
    await expect(startLeadTeamRun(actor, later)).rejects.toThrow(/en fazla/);
    // Başka çalışma alanı sınırdan etkilenmez.
    cookieJar.set(SESSION_COOKIE, tokens.FOREIGN!);
    expect((await runTeam(req("/api/lead-team", "POST", {}))).status).toBe(200);
  });

  it("canlı modda yapay zekâ ayarlı değilse çalışmaz", async () => {
    mockMode(false);
    as("OWNER");
    expect((await runTeam(req("/api/lead-team", "POST", {}))).status).toBe(503);
    expect(await prisma.leadTeamRun.count({ where: { workspaceId } })).toBe(0);
  });

  it("gerçek çağrıda ajanlara kişisel veri gitmez; her çağrı günlüğe yazılır", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-placeholder");
    vi.stubEnv("LLM_MODEL", "test-model");
    const proposal = { title: "Almanya lead formu", market: "GERMANY", language: "DE", service: "Saç ekimi", angle: "Süreci anlatan mesaj", dailyBudget: 40, rationale: "Talep yüksek" };
    const reply = (system: string) =>
      system.includes("Your role: director")
        ? { decision: "Almanya'da Almanca lead formu ile başlanır.", proposals: [{ ...proposal, priority: "HIGH", sourceTeams: ["market"] }], rejected: [] }
        : system.includes("Your role: lead of")
          ? { summary: "Takım özeti", proposals: [proposal], risks: [] }
          : { findings: ["Bulgu"], proposals: [proposal], confidence: 0.6 };
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { system: string };
      return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply(body.system)) }], usage: { input_tokens: 100, output_tokens: 20 } });
    });

    const run = await startLeadTeamRun({ orgId, workspaceId, userId: userIds.OWNER! });
    expect(run.simulated).toBe(false);
    await executeLeadTeamRun(run.id, { transport });

    expect(transport).toHaveBeenCalledTimes(50);
    const saved = await prisma.leadTeamRun.findUniqueOrThrow({ where: { id: run.id }, include: { proposals: true } });
    expect(saved).toMatchObject({ status: "COMPLETED", simulated: false, agentsCompleted: 50, inputTokens: 5000, outputTokens: 1000 });
    expect(saved.proposals).toHaveLength(1);
    expect(saved.proposals[0]).toMatchObject({ status: "PENDING", market: "GERMANY", language: "DE", dailyBudgetCents: 4000, priority: "HIGH" });

    const sent = transport.mock.calls.map(([, init]) => String(init?.body)).join("\n");
    // Bağlam: klinik, kampanya toplamı ve huni sayıları var.
    expect(sent).toContain("Örnek Klinik");
    expect(sent).toContain("Almanya lead formu");
    expect(sent).toContain('\\"spend\\":123');
    expect(sent).toContain('\\"reason\\":\\"Fiyat\\"');
    // Lead adları, telefon ve kayıp notu yok.
    for (const secret of ["Hildegard", "Musterfrau", "Zeynep", "Gizlisoyad", "eşi karşı", "0532", "özel bir not"]) expect(sent).not.toContain(secret);

    const logs = await prisma.llmCallLog.findMany({ where: { workspaceId, agent: { startsWith: "lead-team:" } } });
    expect(logs).toHaveLength(50);
    expect(logs.every((l) => l.promptVersion === "lead-team-v1" && l.model === "test-model" && l.status === "COMPLETED")).toBe(true);
    expect(new Set(logs.map((l) => l.agent)).has("lead-team:director")).toBe(true);
  });
});
