import { describe, expect, it } from "vitest";

import { MetaMarketingClient } from "./client";
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
});
