import { describe, expect, it } from "vitest";

import { MetaMarketingClient, buildCreateCampaignBody, toMetaObjective } from "./client";
import { MetaGraphError } from "./http";

function fakeResponse(bodyObj: unknown, ok: boolean, status: number): Response {
  const headers = new Headers();
  const response = {
    async text(): Promise<string> {
      return typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj);
    },
    headers,
    ok,
    status,
    statusText: ok ? "OK" : "Error",
  } as unknown as Response;
  return response;
}

describe("MetaMarketingClient (gerçek istemci, enjekte edilen fetch)", () => {
  it("getInsights istek URL'si doğru şekillenir (version + act path + fields)", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url, init });
      return fakeResponse(
        {
          data: [
            {
              date_start: "2026-09-15",
              date_stop: "2026-09-15",
              campaign_id: "1",
              impressions: "100",
              spend: "10.5",
              clicks: "3",
            },
          ],
        },
        true,
        200,
      );
    };
    const client = new MetaMarketingClient({
      version: "v26.0",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const rows = await client.getInsights(
      { type: "account", id: "act_111" },
      "tok",
      { datePreset: "last_7d", level: "ad" },
    );

    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(
      "https://graph.facebook.com/v26.0/act_111/insights",
    );
    expect(url.searchParams.get("level")).toBe("ad");
    expect(url.searchParams.get("date_preset")).toBe("last_7d");
    expect(url.searchParams.get("fields")).toContain("impressions");
    expect(url.searchParams.get("access_token")).toBe("tok");

    expect(rows).toHaveLength(1);
    expect(rows[0]!.spendMajor).toBe(10.5);
    expect(rows[0]!.impressions).toBe(100);
  });

  it("Meta hata yükü MetaGraphError'a çevrilir ve subcode korunur", async () => {
    const fetchFn = async (): Promise<Response> =>
      fakeResponse(
        {
          error: {
            code: 100,
            error_subcode: 1487225,
            message: "budget change limit",
          },
        },
        false,
        400,
      );
    const client = new MetaMarketingClient({
      version: "v26.0",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(
      client.updateBudget(
        { entityType: "adset", entityId: "as_1", dailyBudgetCents: 15000 },
        "tok",
      ),
    ).rejects.toMatchObject({ detail: { subcode: 1487225 } });
  });

  it("updateBudget form body'de daily_budget'ı cents olarak gönderir", async () => {
    let sentBody: URLSearchParams | undefined;
    const fetchFn = async (
      _url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      sentBody = init?.body as URLSearchParams;
      return fakeResponse({ success: true }, true, 200);
    };
    const client = new MetaMarketingClient({
      version: "v26.0",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await client.updateBudget(
      { entityType: "adset", entityId: "as_1", dailyBudgetCents: 20050 },
      "tok",
    );
    expect(sentBody?.get("daily_budget")).toBe("20050");
    expect(sentBody?.get("access_token")).toBe("tok");
  });

  it("MetaGraphError AdmedicError tanımlamalarından (META_API_ERROR) türetilir", () => {
    const err = new MetaGraphError({ code: 1, message: "x" });
    expect(err.code).toBe("META_API_ERROR");
    expect(err.status).toBe(502);
  });

  it("listCampaigns/listAdSets daily_budget'ı minor unit olarak dönüşümsüz taşır (…Cents)", async () => {
    const fetchFn = async (url: string): Promise<Response> =>
      fakeResponse(
        url.includes("/campaigns")
          ? { data: [{ id: "c1", name: "K", daily_budget: "50000", lifetime_budget: "0" }] }
          : { data: [{ id: "a1", campaign_id: "c1", name: "A", daily_budget: "15000" }] },
        true,
        200,
      );
    const client = new MetaMarketingClient({ version: "v26.0", fetchFn: fetchFn as unknown as typeof fetch });
    const campaigns = await client.listCampaigns("111", "tok");
    expect(campaigns[0]).toMatchObject({ id: "c1", dailyBudgetCents: 50000, lifetimeBudgetCents: 0 });
    expect(campaigns[0]).not.toHaveProperty("dailyBudgetMajor");
    const adsets = await client.listAdSets("111", "tok");
    expect(adsets[0]).toMatchObject({ id: "a1", campaignId: "c1", dailyBudgetCents: 15000 });
    expect(adsets[0]!.lifetimeBudgetCents).toBeUndefined();
  });

  it("toMetaObjective planlayıcı hedeflerini ODAX'a eşler, OUTCOME_* aynen geçer, bilinmeyen hata verir", () => {
    expect(toMetaObjective("MAX_ROAS")).toBe("OUTCOME_SALES");
    expect(toMetaObjective("MAX_CONVERSIONS")).toBe("OUTCOME_LEADS");
    expect(toMetaObjective("MAX_IMPRESSIONS")).toBe("OUTCOME_AWARENESS");
    expect(toMetaObjective("OUTCOME_TRAFFIC")).toBe("OUTCOME_TRAFFIC");
    expect(() => toMetaObjective("LEAD_GENERATION")).toThrow(/objective/);
  });

  it("createCampaign gövdesi: special_ad_categories=[] zorunlu, status yalnızca PAUSED, daily_budget yalnızca CBO", () => {
    const cbo = buildCreateCampaignBody({
      accountId: "1", name: "K", objective: "MAX_CONVERSIONS", dailyBudgetCents: 20050, budgetStrategy: "CBO",
    });
    expect(cbo).toEqual({
      name: "K", objective: "OUTCOME_LEADS", status: "PAUSED", special_ad_categories: "[]", daily_budget: 20050,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    });
    const abo = buildCreateCampaignBody({
      accountId: "1", name: "K", objective: "MAX_ROAS", dailyBudgetCents: 20050, budgetStrategy: "ABO",
    });
    expect(abo).not.toHaveProperty("daily_budget");
    expect(abo).not.toHaveProperty("bid_strategy");
    // v24+: bütçe ad set'teyken zorunlu (yoksa 100/4834011).
    expect(abo.is_adset_budget_sharing_enabled).toBe("false");
    expect(abo.objective).toBe("OUTCOME_SALES");
    // Strateji verilmezse bütçe kampanya seviyesindedir (CBO varsayımı).
    expect(buildCreateCampaignBody({ accountId: "1", name: "K", objective: "OUTCOME_LEADS", dailyBudgetCents: 100 }))
      .toMatchObject({ daily_budget: 100, status: "PAUSED" });
  });

  it("createCampaign form body'yi Meta'ya gönderir ve review_feedback'i okur", async () => {
    const calls: { url: string; body?: URLSearchParams }[] = [];
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, body: init?.body as URLSearchParams | undefined });
      if (init?.method === "POST") return fakeResponse({ id: "9001" }, true, 200);
      return fakeResponse({ id: "9001", review_feedback: { global: { personal_health: "x" } } }, true, 200);
    };
    const client = new MetaMarketingClient({ version: "v26.0", fetchFn: fetchFn as unknown as typeof fetch });
    const result = await client.createCampaign(
      { accountId: "111", name: "Kampanya", objective: "MAX_IMPRESSIONS", dailyBudgetCents: 30000 },
      "tok",
    );
    expect(result).toMatchObject({ success: true, campaignId: "9001", reviewFeedbackGlobal: { personal_health: "x" } });
    const post = calls[0]!;
    expect(new URL(post.url).pathname).toBe("/v26.0/act_111/campaigns");
    expect(post.body?.get("objective")).toBe("OUTCOME_AWARENESS");
    expect(post.body?.get("status")).toBe("PAUSED");
    expect(post.body?.get("special_ad_categories")).toBe("[]");
    expect(post.body?.get("daily_budget")).toBe("30000");
    expect(post.body?.get("access_token")).toBe("tok");
    expect(new URL(calls[1]!.url).searchParams.get("fields")).toBe("review_feedback");
  });

  it("ad set / kreatif / reklam / lead formu doğru uca form gövdesiyle gider ve id döner", async () => {
    const calls: { url: string; body?: URLSearchParams }[] = [];
    let next = 100;
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, body: init?.body as URLSearchParams | undefined });
      return fakeResponse({ id: String(next++) }, true, 200);
    };
    const client = new MetaMarketingClient({ version: "v26.0", fetchFn: fetchFn as unknown as typeof fetch });
    expect((await client.createAdSet("act_111", { name: "AS", status: "PAUSED" }, "tok")).id).toBe("100");
    expect((await client.createAdCreative("111", { name: "CR" }, "tok")).id).toBe("101");
    expect((await client.createAd("111", { name: "AD", status: "PAUSED" }, "tok")).id).toBe("102");
    expect((await client.createLeadForm("555", { name: "F" }, "page-tok")).id).toBe("103");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v26.0/act_111/adsets",
      "/v26.0/act_111/adcreatives",
      "/v26.0/act_111/ads",
      "/v26.0/555/leadgen_forms",
    ]);
    expect(calls[0]!.body?.get("status")).toBe("PAUSED");
    expect(calls[3]!.body?.get("access_token")).toBe("page-tok");
  });

  it("id dönmeyen oluşturma yanıtı sessizce yutulmaz", async () => {
    const fetchFn = async (): Promise<Response> => fakeResponse({ success: true }, true, 200);
    const client = new MetaMarketingClient({ version: "v26.0", fetchFn: fetchFn as unknown as typeof fetch });
    await expect(client.createAd("111", { name: "AD" }, "tok")).rejects.toThrow(/id dönmedi/);
  });

  it("uploadAdImage bytes gönderir ve images içindeki hash'i okur; searchAdLocales adlocale arar", async () => {
    const calls: { url: string; body?: URLSearchParams }[] = [];
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, body: init?.body as URLSearchParams | undefined });
      if (init?.method === "POST") return fakeResponse({ images: { bytes: { hash: "abc123", url: "https://cdn/x.jpg" } } }, true, 200);
      return fakeResponse({ data: [{ key: 1001, name: "English (All)" }, { key: "x", name: "Bozuk" }] }, true, 200);
    };
    const client = new MetaMarketingClient({ version: "v26.0", fetchFn: fetchFn as unknown as typeof fetch });
    expect(await client.uploadAdImage("111", { bytesBase64: "aGVsbG8=", filename: "a.jpg" }, "tok")).toEqual({
      hash: "abc123",
      url: "https://cdn/x.jpg",
    });
    expect(new URL(calls[0]!.url).pathname).toBe("/v26.0/act_111/adimages");
    expect(calls[0]!.body?.get("bytes")).toBe("aGVsbG8=");
    expect(await client.searchAdLocales("English", "tok")).toEqual([{ key: 1001, name: "English (All)" }]);
    const search = new URL(calls[1]!.url);
    expect(search.pathname).toBe("/v26.0/search");
    expect(search.searchParams.get("type")).toBe("adlocale");
    expect(search.searchParams.get("q")).toBe("English");
  });
});
