import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (key: string) => cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined,
}) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { GET as insights } from "../app/api/insights/route";
import { GET as weeklyReport } from "../app/api/reports/weekly/route";

function utcDay(offset: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offset);
  return d;
}

interface InsightsBody {
  currency: string;
  insights: {
    period: { days: number };
    summary: { totalSpend: number; totalImpressions: number; totalClicks: number; ctr: number; cpmCents: number | null; cpcCents: number | null; cplCents: number | null; totalLeads: number; qualifiedLeads: number; qualifiedLeadRatio: number };
    daily: Array<{ date: string; spend: number; clicks: number }>;
    campaigns: Array<{ id: string; budgetCents: number | null; spentCents: number; days: number; spendPercent: number; leadCount: number; cplCents: number | null }>;
    byCountry: Array<{ country: string | null; leads: number; qualified: number }>;
    byLanguage: Array<{ language: string; leads: number; qualified: number }>;
  };
  alerts: Array<{ id: string }>;
}

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("insights and weekly report", () => {
  const suffix = randomBytes(8).toString("hex");
  const users: string[] = [];
  const orgs: string[] = [];
  let token = "";
  let workspaceId = "";
  let campaignId = "";

  beforeAll(async () => {
    for (const foreign of [false, true]) {
      const org = await prisma.organization.create({ data: {
        name: "Insights fixture", slug: `insights-${suffix}-${foreign}`,
        workspaces: { create: { name: "Ins", slug: "ins", currency: "EUR" } },
      }, include: { workspaces: true } });
      orgs.push(org.id);
      const wsId = org.workspaces[0].id;
      const account = await prisma.adAccount.create({ data: { orgId: org.id, workspaceId: wsId, name: "Hesap", currency: foreign ? "USD" : "TRY", isDefault: true } });
      const campaign = await prisma.campaign.create({ data: { adAccountId: account.id, workspaceId: wsId, name: foreign ? "Yabancı" : "Ana", status: "ACTIVE", dailyBudget: 50_000 } });
      const other = await prisma.campaign.create({ data: { adAccountId: account.id, workspaceId: wsId, name: "İkinci", status: "PAUSED", dailyBudget: 10_000 } });
      if (!foreign) {
        workspaceId = wsId;
        campaignId = campaign.id;
        const user = await prisma.user.create({ data: { email: `${suffix}-viewer@example.invalid` } });
        users.push(user.id);
        await prisma.membership.create({ data: { orgId: org.id, userId: user.id, role: "VIEWER" } });
        token = randomBytes(32).toString("hex");
        await prisma.webSession.create({ data: { tokenHash: tokenHash(token), userId: user.id, workspaceId: wsId, expiresAt: new Date(Date.now() + 600_000) } });
      }
      const base = { workspaceId: wsId, adAccountId: account.id, granularity: "DAILY" as const };
      await prisma.insightSnapshot.createMany({ data: [
        // 3 gün ana kampanya: 40.000 + 40.000 + 40.000 cent; 2. gün ikinci kampanya da var (günlük seri toplanır).
        { ...base, campaignId: campaign.id, date: utcDay(1), spend: 40_000, impressions: 10_000, clicks: 200, leads: 4, purchases: 1, conversionValue: 100_000 },
        { ...base, campaignId: campaign.id, date: utcDay(2), spend: 40_000, impressions: 10_000, clicks: 200, leads: 4, purchases: 0, conversionValue: 0 },
        { ...base, campaignId: other.id, date: utcDay(2), spend: 5_000, impressions: 5_000, clicks: 50, leads: 1, purchases: 0, conversionValue: 0 },
        { ...base, campaignId: campaign.id, date: utcDay(3), spend: 40_000, impressions: 10_000, clicks: 200, leads: 2, purchases: 0, conversionValue: 0 },
        // 40 gün önce: dönem dışı.
        { ...base, campaignId: campaign.id, date: utcDay(40), spend: 999_999, impressions: 1, clicks: 1, leads: 0, purchases: 0, conversionValue: 0 },
      ] });
      const leadBase = { workspaceId: wsId, organizationId: org.id, lastName: "X", consentGiven: true };
      await prisma.lead.createMany({ data: [
        { ...leadBase, firstName: "A", country: "DE", language: "de", status: "QUALIFIED", lookupHash: `h1-${suffix}-${foreign}` },
        { ...leadBase, firstName: "B", country: "DE", language: "de", status: "TREATED", lookupHash: `h2-${suffix}-${foreign}` },
        { ...leadBase, firstName: "C", country: "GB", language: "en", status: "NEW", lookupHash: `h3-${suffix}-${foreign}` },
        { ...leadBase, firstName: "D", country: "GB", language: "en", status: "CONTACTED", lookupHash: `h4-${suffix}-${foreign}` },
        { ...leadBase, firstName: "E", country: null, language: "ru", status: "LOST", lookupHash: `h5-${suffix}-${foreign}` },
      ] });
      await prisma.alert.createMany({ data: [
        { workspaceId: wsId, type: "ROAS_DROP", severity: "WARNING", title: "Açık", message: "m" },
        { workspaceId: wsId, type: "HIGH_CPA", severity: "CRITICAL", title: "Çözüldü", message: "m", status: "RESOLVED", read: true, resolvedAt: new Date() },
      ] });
    }
    cookieJar.set(SESSION_COOKIE, token);
  });
  afterAll(async () => {
    cookieJar.clear();
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it("son 30 günü hesap para birimiyle, cent/cent oranlarla ve pazar/dil kırılımıyla döndürür", async () => {
    const res = await insights();
    expect(res.status).toBe(200);
    const body = await res.json() as InsightsBody;
    expect(body.currency).toBe("TRY");
    expect(body.insights.period.days).toBe(30);
    const s = body.insights.summary;
    expect(s.totalSpend).toBe(125_000);
    expect(s.totalImpressions).toBe(35_000);
    expect(s.totalClicks).toBe(650);
    expect(s.cpmCents).toBe(Math.round((125_000 / 35_000) * 1000));
    expect(s.cpcCents).toBe(Math.round(125_000 / 650));
    expect(s.ctr).toBeCloseTo(650 / 35_000, 4);
    // Nitelikli: QUALIFIED + TREATED = 2 / 5 lead.
    expect(s.totalLeads).toBe(5);
    expect(s.qualifiedLeads).toBe(2);
    expect(s.qualifiedLeadRatio).toBeCloseTo(0.4, 4);
    expect(s.cplCents).toBe(Math.round(125_000 / 5));

    // Günlük seri: aynı gün toplanır, dönem dışı satır yok.
    expect(body.insights.daily).toHaveLength(3);
    const day2 = body.insights.daily.find((d) => d.date === utcDay(2).toISOString().slice(0, 10));
    expect(day2?.spend).toBe(45_000);
    expect(day2?.clicks).toBe(250);

    // Kampanya kırılımı: yalnızca ACTIVE; harcama / (günlük bütçe × veri günü) = 120.000 / 150.000 = %80.
    expect(body.insights.campaigns).toHaveLength(1);
    const c = body.insights.campaigns[0];
    expect(c.id).toBe(campaignId);
    expect(c).toMatchObject({ budgetCents: 50_000, spentCents: 120_000, days: 3, spendPercent: 80, leadCount: 10, cplCents: 12_000 });

    expect(body.insights.byCountry).toEqual([
      { country: "DE", leads: 2, qualified: 2 },
      { country: "GB", leads: 2, qualified: 0 },
      { country: null, leads: 1, qualified: 0 },
    ]);
    expect(body.insights.byLanguage).toEqual([
      { language: "de", leads: 2, qualified: 2 },
      { language: "en", leads: 2, qualified: 0 },
      { language: "ru", leads: 1, qualified: 0 },
    ]);
    // Yalnızca OPEN uyarılar; yabancı workspace verisi sızmaz.
    expect(body.alerts).toHaveLength(1);
    expect(await prisma.alert.count({ where: { workspaceId, status: "OPEN" } })).toBe(1);
  });

  it("haftalık rapor GET'i Origin başlığı olmadan çalışır; pdf=1 PDF indirir; oturumsuz 401", async () => {
    const json = await weeklyReport(new Request("http://localhost:3000/api/reports/weekly"));
    expect(json.status).toBe(200);
    const body = await json.json() as { report: { period: { start: string; end: string }; summary: { totalSpend: number } } };
    expect(body.report.period.start < body.report.period.end).toBe(true);
    expect(typeof body.report.summary.totalSpend).toBe("number");

    const pdf = await weeklyReport(new Request("http://localhost:3000/api/reports/weekly?pdf=1"));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain("haftalik-rapor-");
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 4)).toString()).toBe("%PDF");

    cookieJar.clear();
    expect((await weeklyReport(new Request("http://localhost:3000/api/reports/weekly"))).status).toBe(401);
    expect((await insights()).status).toBe(401);
    cookieJar.set(SESSION_COOKIE, token);
  });
});
