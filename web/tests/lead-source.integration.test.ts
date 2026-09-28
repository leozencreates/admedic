import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

const { cookieJar } = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) =>
      cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined,
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

import { GET as leadGet } from "../app/api/leads/[id]/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = async (id: string) => {
  const res = await leadGet(new Request(`http://localhost:3000/api/leads/${id}`), ctx(id));
  expect(res.status).toBe(200);
  return (await res.json()).lead as {
    campaignId: string | null;
    source: { campaign: { id: string; name: string } | null; adSet: { id: string; name: string } | null; ad: { id: string; name: string } | null };
  };
};

/** Lead ayrıntısındaki "Kaynak kampanya": kimlik yerine paneldeki ad (Faz 1 · 5c). */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("lead source names on GET /api/leads/:id", () => {
  const suffix = randomBytes(8).toString("hex");
  const orgIds: string[] = [];
  let userId = "";
  let workspaceId = "";
  let orgId = "";
  const ids = { campaign: "", adSet: "", ad: "", foreignCampaignMeta: `fc-${suffix}` };

  async function tree(org: string, workspace: string, tag: string, metaCampaignId: string) {
    const account = await prisma.adAccount.create({
      data: { orgId: org, workspaceId: workspace, name: `Hesap ${tag}`, metaAccountId: `act_${tag}_${suffix}` },
    });
    const campaign = await prisma.campaign.create({
      data: { adAccountId: account.id, workspaceId: workspace, metaCampaignId, name: `Saç ekimi · Almanya ${tag}` },
    });
    const adSet = await prisma.adSet.create({
      data: { campaignId: campaign.id, workspaceId: workspace, metaAdSetId: `as-${tag}-${suffix}`, name: `DE 30-50 ${tag}` },
    });
    const ad = await prisma.ad.create({
      data: { adSetId: adSet.id, workspaceId: workspace, metaAdId: `ad-${tag}-${suffix}`, name: `Varyant A ${tag}` },
    });
    return { campaign, adSet, ad };
  }

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { email: `source-${suffix}@example.invalid` } });
    userId = user.id;
    const org = await prisma.organization.create({
      data: {
        name: "Source fixture", slug: `source-${suffix}`,
        members: { create: { userId, role: "PATIENT_COORDINATOR" } },
        workspaces: { create: { name: "Ws", slug: "ws-source" } },
      },
      include: { workspaces: true },
    });
    orgId = org.id;
    orgIds.push(org.id);
    workspaceId = org.workspaces[0].id;
    const own = await tree(orgId, workspaceId, "own", `mc-${suffix}`);
    ids.campaign = own.campaign.id;
    ids.adSet = own.adSet.id;
    ids.ad = own.ad.id;
    // Başka organizasyonun kampanyası: aynı Meta kimliğini taşıyan lead'e adı sızmamalı.
    const foreign = await prisma.organization.create({
      data: { name: "Foreign", slug: `source-foreign-${suffix}`, workspaces: { create: { name: "F", slug: "f" } } },
      include: { workspaces: true },
    });
    orgIds.push(foreign.id);
    await tree(foreign.id, foreign.workspaces[0].id, "foreign", ids.foreignCampaignMeta);
    const token = randomBytes(32).toString("hex");
    await prisma.webSession.create({
      data: { tokenHash: tokenHash(token), userId, workspaceId, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set(SESSION_COOKIE, token);
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const lead = (data: { campaignId?: string | null; adSetId?: string | null; adId?: string | null }) =>
    prisma.lead.create({
      data: { workspaceId, organizationId: orgId, firstName: "Kaynak", lastName: suffix, channel: "LEAD_AD", ...data },
    });

  it("resolves Meta ids (Lead Ads webhook) to the campaign, ad set and ad names", async () => {
    const created = await lead({ campaignId: `mc-${suffix}`, adSetId: `as-own-${suffix}`, adId: `ad-own-${suffix}` });
    const { source, campaignId } = await get(created.id);
    expect(campaignId).toBe(`mc-${suffix}`); // ham kimlik "Teknik ayrıntı" için yanıtta kalır
    expect(source).toEqual({
      campaign: { id: ids.campaign, name: "Saç ekimi · Almanya own" },
      adSet: { id: ids.adSet, name: "DE 30-50 own" },
      ad: { id: ids.ad, name: "Varyant A own" },
    });
  });

  it("derives the campaign from the ad for click-to-message leads and accepts panel ids", async () => {
    const adOnly = await lead({ adId: `ad-own-${suffix}` });
    expect((await get(adOnly.id)).source).toEqual({
      campaign: { id: ids.campaign, name: "Saç ekimi · Almanya own" },
      adSet: { id: ids.adSet, name: "DE 30-50 own" },
      ad: { id: ids.ad, name: "Varyant A own" },
    });
    const panelIds = await lead({ campaignId: ids.campaign });
    expect((await get(panelIds.id)).source).toEqual({
      campaign: { id: ids.campaign, name: "Saç ekimi · Almanya own" },
      adSet: null,
      ad: null,
    });
  });

  it("never resolves another organisation's campaign and returns nulls without ids", async () => {
    const foreign = await lead({ campaignId: ids.foreignCampaignMeta, adId: `ad-foreign-${suffix}` });
    expect((await get(foreign.id)).source).toEqual({ campaign: null, adSet: null, ad: null });
    const none = await lead({});
    expect((await get(none.id)).source).toEqual({ campaign: null, adSet: null, ad: null });
  });
});
