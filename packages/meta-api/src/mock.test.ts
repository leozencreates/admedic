import { describe, expect, it } from "vitest";

import { createMetaClient } from "./index";
import { MockMetaClient } from "./mock";

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

  it("aggregate (default): tek satır, aralık toplamı", async () => {
    const rows = await client.getInsights(
      { type: "adset", id: "as_mock_1_0" },
      TOKEN,
      {
        timeRange: { since: "2026-09-01", until: "2026-09-10" },
        timeIncrement: "all_days",
      },
    );
    expect(rows).toHaveLength(5); // adset başına 5 ad
    for (const row of rows) {
      expect(row.adId).toBeDefined();
      expect(row.spendMajor).toBeGreaterThan(0);
      expect(row.dateStart).toBe("2026-09-01");
      expect(row.dateStop).toBe("2026-09-10");
    }
  });

  it("listCampaigns/listAdSets/listAds mock hesaba bağlı", async () => {
    const campaigns = await client.listCampaigns("act_mock_001", TOKEN);
    expect(campaigns).toHaveLength(5);
    const adsets = await client.listAdSets("act_mock_001", TOKEN);
    expect(adsets).toHaveLength(10);
    const ads = await client.listAds("act_mock_001", TOKEN);
    expect(ads).toHaveLength(50);
    expect(await client.listAds("act_other", TOKEN)).toHaveLength(0);
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
});
