import { describe, expect, it, vi } from "vitest";

import { createMetaClient } from "./index";
import { MetaGraphError } from "./http";
import { MockMetaClient, mockMetaFailures } from "./mock";
import { buildAdBody, buildAdCreativeBody, buildAdSetBody, buildLeadFormBody, pickLocaleKeys, resolveDelivery } from "./publish";

it("createMetaClient mock=true deterministik mock döner", () => {
  const client = createMetaClient({ mock: true, version: "v26.0" });
  expect(client).toBeInstanceOf(MockMetaClient);
  expect(client.getVersion()).toBe("v26.0");
});

describe("MockMetaClient", () => {
  const client = new MockMetaClient({ version: "v26.0" });
  const TOKEN = "mock-token";

  it("rekabette deterministik: aynı sorgu aynı sonuç, farklı gün farklı veri", async () => {
    const q = { datePreset: "last_7d" as const };
    const [a1, a2] = await Promise.all([
      client.getInsights({ type: "ad", id: "ad_mock_0_0_0" }, TOKEN, q),
      client.getInsights({ type: "ad", id: "ad_mock_0_0_0" }, TOKEN, q),
    ]);
    expect(a1).toEqual(a2);

    const other = await client.getInsights(
      { type: "ad", id: "ad_mock_0_0_1" },
      TOKEN,
      q,
    );
    expect(other.map((r) => r.spendMajor)).not.toEqual(
      a1.map((r) => r.spendMajor),
    );
  });

  it("ad seviyesi satırların alanları dolu ve pozitif", async () => {
    const rows = await client.getInsights(
      { type: "ad", id: "ad_mock_2_0_0" },
      TOKEN,
      {
        timeRange: { since: "2026-09-09", until: "2026-09-15" },
        timeIncrement: 1,
      },
    );
    expect(rows).toHaveLength(7);
    const last = rows[6]!;
    expect(last.adsetId).toBe("as_mock_2_0");
    expect(last.campaignId).toBe("cmp_mock_3");
    expect(last.impressions).toBeGreaterThan(0);
    expect(last.spendMajor).toBeGreaterThan(0);
    expect(last.ctr).toBeGreaterThan(0);
  });

  it("aggregate (default): adset seviyesi TEK satır, aralık toplamı (ad başına satır değil)", async () => {
    const rows = await client.getInsights(
      { type: "adset", id: "as_mock_1_0" },
      TOKEN,
      {
        timeRange: { since: "2026-09-01", until: "2026-09-10" },
        timeIncrement: "all_days",
      },
    );
    expect(rows).toHaveLength(1); // adset toplamı tek satır
    const row = rows[0]!;
    expect(row.adId).toBeUndefined();
    expect(row.adsetId).toBe("as_mock_1_0");
    expect(row.campaignId).toBe("cmp_mock_2");
    expect(row.spendMajor).toBeGreaterThan(0);
    expect(row.dateStart).toBe("2026-09-01");
    expect(row.dateStop).toBe("2026-09-10");

    // Adset toplamı = içindeki 5 ad'ın toplamı (gerçek Meta ile aynı): fan-out sapması yok.
    const ads = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        client.getInsights(
          { type: "ad", id: `ad_mock_1_0_${i}` },
          TOKEN,
          { timeRange: { since: "2026-09-01", until: "2026-09-10" } },
        ),
      ),
    );
    const expectedSpend = ads.reduce((a, r) => a + r[0]!.spendMajor, 0);
    expect(row.spendMajor).toBeCloseTo(expectedSpend, 2);
  });

  it("kampanya seviyesi tek satır; account seviyesi query.level kırılımına göre satır döner", async () => {
    const campaign = await client.getInsights(
      { type: "campaign", id: "cmp_mock_2" },
      TOKEN,
      { timeRange: { since: "2026-09-01", until: "2026-09-10" } },
    );
    expect(campaign).toHaveLength(1);
    expect(campaign[0]!.campaignId).toBe("cmp_mock_2");
    expect(campaign[0]!.adsetId).toBeUndefined();
    expect(campaign[0]!.adId).toBeUndefined();

    const byCampaign = await client.getInsights(
      { type: "account", id: "act_mock_001" },
      TOKEN,
      { timeRange: { since: "2026-09-01", until: "2026-09-10" }, level: "campaign" },
    );
    expect(byCampaign).toHaveLength(5);

    const byAd = await client.getInsights(
      { type: "account", id: "act_mock_001" },
      TOKEN,
      { timeRange: { since: "2026-09-01", until: "2026-09-10" }, level: "ad" },
    );
    expect(byAd).toHaveLength(50);
  });

  it("takvim tabanlı date presets gerçek pencereyi döner (yesterday/this_month/last_month)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
      const ref = { type: "ad" as const, id: "ad_mock_0_0_0" };

      const yesterday = await client.getInsights(ref, TOKEN, { datePreset: "yesterday", timeIncrement: 1 });
      expect(yesterday).toHaveLength(1);
      expect(yesterday[0]!.dateStart).toBe("2026-09-29");
      expect(yesterday[0]!.dateStop).toBe("2026-09-29");

      const thisMonth = await client.getInsights(ref, TOKEN, { datePreset: "this_month", timeIncrement: 1 });
      // Günler en yeniden en eskiye sıralanır.
      expect(thisMonth[0]!.dateStart).toBe("2026-09-30");
      expect(thisMonth.at(-1)!.dateStart).toBe("2026-09-01");

      const lastMonth = await client.getInsights(ref, TOKEN, { datePreset: "last_month", timeIncrement: 1 });
      expect(lastMonth[0]!.dateStart).toBe("2026-08-31");
      expect(lastMonth.at(-1)!.dateStart).toBe("2026-08-01");
    } finally {
      vi.useRealTimers();
    }
  });

  it("listCampaigns/listAdSets/listAds mock hesaba bağlı; bütçeler minor unit (…Cents)", async () => {
    const campaigns = await client.listCampaigns("act_mock_001", TOKEN);
    expect(campaigns).toHaveLength(5);
    expect(campaigns[0]!.dailyBudgetCents).toBe(50_000);
    expect(campaigns[0]).not.toHaveProperty("dailyBudgetMajor");
    const adsets = await client.listAdSets("act_mock_001", TOKEN);
    expect(adsets).toHaveLength(10);
    expect(adsets[0]!.dailyBudgetCents).toBe(15_000);
    const ads = await client.listAds("act_mock_001", TOKEN);
    expect(ads).toHaveLength(50);
    expect(await client.listAds("act_other", TOKEN)).toHaveLength(0);
  });

  it("günlük satırlarda CPM = spend / impressions * 1000", async () => {
    const rows = await client.getInsights(
      { type: "ad", id: "ad_mock_1_1_2" },
      TOKEN,
      { timeRange: { since: "2026-09-10", until: "2026-09-12" }, timeIncrement: 1 },
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.cpm).toBeCloseTo((row.spendMajor / row.impressions) * 1000, 1);
      expect(row.cpm).toBeGreaterThan(0);
    }
  });

  it("updateBudget/setStatus başarılı sonuç döner", async () => {
    const r = await client.updateBudget(
      { entityType: "adset", entityId: "as_mock_1_0", dailyBudgetCents: 15000 },
      TOKEN,
    );
    expect(r.success).toBe(true);
    const s = await client.setStatus(
      { entityType: "adset", entityId: "as_mock_1_0", status: "PAUSED" },
      TOKEN,
    );
    expect(s.success).toBe(true);
  });
  it("createCampaign deterministik PAUSED kampanya id'si üretir", async () => {
    const first = await client.createCampaign(
      { accountId: "act_mock_001", name: "Yaz Kampanyası", objective: "OUTCOME_LEADS", status: "PAUSED" },
      TOKEN,
    );
    const second = await client.createCampaign(
      { accountId: "act_mock_001", name: "Yaz Kampanyası", objective: "OUTCOME_LEADS", status: "PAUSED" },
      TOKEN,
    );
    expect(first.success).toBe(true);
    expect(first.campaignId).toMatch(/^cmp_mock_pub_\d+$/);
    expect(first.campaignId).toBe(second.campaignId);
    expect(first.metaResponse).toMatchObject({ status: "PAUSED", objective: "OUTCOME_LEADS", special_ad_categories: [] });
  });

  it("createCampaign objective eşlemesi ve CBO/ABO bütçe kuralı gerçek istemciyle aynı", async () => {
    const cbo = await client.createCampaign(
      { accountId: "act_mock_001", name: "CBO", objective: "MAX_ROAS", dailyBudgetCents: 20_000, budgetStrategy: "CBO" },
      TOKEN,
    );
    expect(cbo.metaResponse).toMatchObject({ objective: "OUTCOME_SALES", daily_budget: 20_000 });
    const abo = await client.createCampaign(
      { accountId: "act_mock_001", name: "ABO", objective: "MAX_CONVERSIONS", dailyBudgetCents: 20_000, budgetStrategy: "ABO" },
      TOKEN,
    );
    expect(abo.metaResponse).toMatchObject({ objective: "OUTCOME_LEADS" });
    expect(abo.metaResponse).not.toHaveProperty("daily_budget");
    await expect(
      client.createCampaign({ accountId: "act_mock_001", name: "X", objective: "CONVERSIONS" }, TOKEN),
    ).rejects.toThrow(/objective/);
  });
});

describe("MockMetaClient — tam yayın yazma uçları", () => {
  const client = new MockMetaClient({ version: "v26.0" });
  const TOKEN = "mock-token";
  const leadDelivery = resolveDelivery("MAX_CONVERSIONS", "instant_form");

  it("gerçek istemcinin gövde kurallarını uygular ve belirleyici kimlik döndürür", async () => {
    const body = buildAdSetBody({
      campaignId: "cmp_1",
      name: "DE",
      delivery: leadDelivery,
      targeting: { countries: ["DE"], localeKeys: [5], ageMin: 25, ageMax: 54 },
      dailyBudgetCents: 3000,
      pageId: "page_mock_1",
    });
    const a = await client.createAdSet("act_mock_001", body, TOKEN);
    const b = await client.createAdSet("act_mock_001", body, TOKEN);
    expect(a.id).toMatch(/^as_mock_pub_\d+$/);
    expect(a.id).toBe(b.id);
    await expect(client.createAdSet("act_mock_001", { ...body, status: "ACTIVE" }, TOKEN)).rejects.toThrow(/PAUSED/);
    const under18 = { ...body, targeting: JSON.stringify({ geo_locations: { countries: ["DE"] }, age_min: 16, age_max: 30 }) };
    await expect(client.createAdSet("act_mock_001", under18, TOKEN)).rejects.toThrow(/age_min/);
    const { bid_strategy: _dropped, ...noBid } = body;
    await expect(client.createAdSet("act_mock_001", noBid, TOKEN)).rejects.toThrow(/bid_strategy/);

    const creative = buildAdCreativeBody({
      name: "CR", pageId: "page_mock_1", delivery: leadDelivery, imageHash: "h", headline: "H", text: "T", cta: "SIGN_UP", leadFormId: "lf_1",
    });
    expect((await client.createAdCreative("act_mock_001", creative, TOKEN)).id).toMatch(/^cr_mock_pub_\d+$/);
    const noImage = JSON.stringify({ page_id: "p", link_data: { link: "x", message: "m", call_to_action: {} } });
    await expect(client.createAdCreative("act_mock_001", { ...creative, object_story_spec: noImage }, TOKEN)).rejects.toThrow(/image_hash/);

    const ad = buildAdBody({ name: "AD", adSetId: a.id, creativeId: "cr_1" });
    expect((await client.createAd("act_mock_001", ad, TOKEN)).id).toMatch(/^ad_mock_pub_\d+$/);
    await expect(client.createAd("act_mock_001", { ...ad, status: "ACTIVE" }, TOKEN)).rejects.toThrow(/PAUSED/);

    const form = buildLeadFormBody({
      name: "F", language: "TR", customQuestions: ["Soru"], privacyPolicyUrl: "https://k.example/gizlilik", privacyLinkText: "Gizlilik",
      consent: { title: "Rıza", body: "Metin", checkboxText: "Onaylıyorum" },
    });
    expect((await client.createLeadForm("page_mock_1", form, "mock-page-token")).id).toMatch(/^lf_mock_\d+$/);

    const image = await client.uploadAdImage("act_mock_001", { bytesBase64: "iVBORw0KGgo=", filename: "a.png" }, TOKEN);
    expect(image.hash).toMatch(/^mockhash[0-9a-f]+$/);
    expect(pickLocaleKeys("EN", await client.searchAdLocales("English", TOKEN))).toEqual([1001]);
    expect(pickLocaleKeys("DE", await client.searchAdLocales("German", TOKEN))).toEqual([5]);
  });

  it("mockMetaFailures ile enjekte edilen hata yalnızca belirtilen sayıda çağrıyı etkiler", async () => {
    mockMetaFailures.reset();
    mockMetaFailures.fail("createAd", 1);
    const ad = buildAdBody({ name: "AD", adSetId: "as_1", creativeId: "cr_1" });
    await expect(client.createAd("act_mock_001", ad, TOKEN)).rejects.toBeInstanceOf(MetaGraphError);
    await expect(client.createAd("act_mock_001", ad, TOKEN)).resolves.toMatchObject({ id: expect.stringMatching(/^ad_mock_pub_/) });
    mockMetaFailures.fail("setStatus", 2);
    mockMetaFailures.reset();
    await expect(client.setStatus({ entityType: "ad", entityId: "x", status: "ACTIVE" }, TOKEN)).resolves.toMatchObject({ success: true });
  });
});
