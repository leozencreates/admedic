import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined),
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

import { GET as campaignGet } from "../app/api/campaigns/[id]/route";
import { campaignMetrics, sinceDays } from "../app/_lib/campaign-metrics";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string) => new Request(`http://localhost:3000/api/campaigns/${id}`);

/**
 * Kampanya sayfası (ADR-0020): insight anlık görüntüleri reklam, reklam seti ya da kampanya düzeyinde olabilir;
 * kampanya toplamında hepsi toplanır, aynı gün için hem kampanya hem alt düzey satırı varsa çift sayılmaz.
 * Uç çalışma alanı dışındaki kampanyaya 404 döner; kararlarda reklam adı gelir.
 */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("kampanya sayfası verisi", () => {
  const suffix = randomBytes(8).toString("hex");
  const orgIds: string[] = [];
  let userId = "";
  let workspaceId = "";
  let campaignId = "";
  let foreignCampaignId = "";
  let adId = "";
  const today = sinceDays(1);
  const yesterday = sinceDays(2);

  beforeAll(async () => {
    for (const foreign of [false, true]) {
      const org = await prisma.organization.create({
        data: { name: "Kampanya", slug: `camp-${suffix}-${foreign}`, workspaces: { create: { name: "Ws", slug: "ws" } } },
        include: { workspaces: true },
      });
      orgIds.push(org.id);
      const wsId = org.workspaces[0].id;
      const account = await prisma.adAccount.create({ data: { orgId: org.id, workspaceId: wsId, name: "Hesap", currency: "EUR" } });
      const campaign = await prisma.campaign.create({
        data: { adAccountId: account.id, workspaceId: wsId, name: `Almanya — Saç ekimi ${foreign}`, dailyBudget: 5000 },
      });
      if (foreign) {
        foreignCampaignId = campaign.id;
        continue;
      }
      workspaceId = wsId;
      campaignId = campaign.id;
      const adSet = await prisma.adSet.create({ data: { campaignId: campaign.id, workspaceId: wsId, name: "Set A", dailyBudget: 5000 } });
      const ad = await prisma.ad.create({ data: { adSetId: adSet.id, workspaceId: wsId, name: "Reklam 1" } });
      adId = ad.id;
      // Dün: yalnızca reklam düzeyi (toplanır). Bugün: hem kampanya hem reklam düzeyi (yalnızca kampanya sayılır).
      await prisma.insightSnapshot.createMany({
        data: [
          { workspaceId: wsId, adId: ad.id, date: yesterday, spend: 1000, leads: 2, clicks: 50, impressions: 1000 },
          { workspaceId: wsId, adId: ad.id, date: today, spend: 700, leads: 1, clicks: 30, impressions: 600 },
          { workspaceId: wsId, campaignId: campaign.id, date: today, spend: 800, leads: 1, clicks: 35, impressions: 700 },
        ],
      });
      await prisma.agentDecision.create({
        data: { workspaceId: wsId, targetType: "AD", targetId: ad.id, action: "PAUSE", reason: "Harcama var, dönüşüm yok." },
      });
      const user = await prisma.user.create({ data: { email: `owner-camp-${suffix}@example.invalid` } });
      userId = user.id;
      await prisma.membership.create({ data: { orgId: org.id, userId, role: "OWNER" } });
      const token = randomBytes(32).toString("hex");
      await prisma.webSession.create({ data: { tokenHash: tokenHash(token), userId, workspaceId: wsId, expiresAt: new Date(Date.now() + 120_000) } });
      cookieJar.set(SESSION_COOKIE, token);
    }
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("reklam düzeyindeki veriler kampanyaya toplanır; aynı günde kampanya düzeyi varsa çift sayılmaz", async () => {
    const totals = await campaignMetrics(workspaceId, sinceDays(7));
    expect(totals.get(campaignId)).toMatchObject({ spend: 1800, leads: 3, clicks: 85 });
  });

  it("kampanya ucu: görünüm, 7/30 gün, günlük seri, reklam seti kırılımı ve reklam adıyla kararlar", async () => {
    const res = await campaignGet(req(campaignId), ctx(campaignId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.campaign).toMatchObject({ id: campaignId, workflowStatus: "DRAFT", publish: { status: "NOT_STARTED" } });
    expect(body.metrics.days7).toMatchObject({ spend: 1800, leads: 3 });
    expect(body.daily.map((d: { spend: number }) => d.spend)).toEqual([1000, 800]);
    // Kampanya düzeyindeki satır reklam seti kırılımına girmez; yalnızca dünkü reklam satırı.
    expect(body.adSets[0]).toMatchObject({ name: "Set A", ads: 1, metrics30: { spend: 1000 } });
    expect(body.decisions[0]).toMatchObject({ targetId: adId, targetName: "Reklam 1", action: "PAUSE" });
  });

  it("başka çalışma alanının kampanyası 404", async () => {
    expect((await campaignGet(req(foreignCampaignId), ctx(foreignCampaignId))).status).toBe(404);
  });
});
