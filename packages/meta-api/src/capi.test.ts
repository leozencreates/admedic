import { describe, expect, it } from "vitest";

import { loadEnv } from "@admedic/config";
import { healthAllowedEvents, postConversionEvents, sanitizeConversionInput } from "./capi";
import { MetaGraphError } from "./http";

function fakeResponse(bodyObj: unknown, ok: boolean, status: number): Response {
  const response = {
    async text(): Promise<string> {
      return JSON.stringify(bodyObj);
    },
    headers: new Headers(),
    ok,
    status,
    statusText: ok ? "OK" : "Error",
  } as unknown as Response;
  return response;
}

const envOverrides = {
  META_APP_ID: "app_123",
  META_APP_SECRET: "secret_abc",
  META_API_VERSION: "v26.0",
  META_MOCK_MODE: "false",
};

describe("capi yardımcısı", () => {
  it("healthAllowedEvents izin verilen türleri döndürür", () => {
    const allowed = healthAllowedEvents();
    expect(allowed).toContain("LEAD");
    expect(allowed).toContain("PURCHASE");
    expect(allowed).not.toContain("INVALID_EVENT");
  });

  it("sanitizeConversionInput sağlığı olmayan alanları filtreler", () => {
    const result = sanitizeConversionInput({
      event_name: "LEAD",
      event_time: "2026-01-01T00:00:00Z",
      diagnosis: "cancer",
      user_data: { em: "x", ph: "y", diagnosis: "z" },
    });
    expect(result).toEqual({
      event_name: "LEAD",
      event_time: "2026-01-01T00:00:00Z",
      user_data: { em: "x", ph: "y" },
    });
  });

  it("postConversionEvents isteğini doğru kurar ve sonucu yorumlar", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const calls: string[] = [];
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push(url);
      return fakeResponse(
        { data: [{ event_id: "evt_1", is_event_duplicated: false }] },
        true,
        200,
      );
    };
    const result = await postConversionEvents(
      "act_999",
      [{ eventName: "LEAD", eventTime: "2026-01-01T00:00:00Z", actionSource: "WEB", eventId: "evt_1" }],
      "tok",
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    const url = new URL(calls[0]!);
    expect(url.origin + url.pathname).toBe(
      "https://graph.facebook.com/v26.0/act_999/events",
    );
    expect(url.searchParams.get("access_token")).toBe("tok");
    expect(result.data[0]?.eventId).toBe("evt_1");
    expect(result.data[0]?.isEventDuplicated).toBe(false);
  });

  it("Meta hata yanıtı MetaGraphError'a çevrilir", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const fetchFn = async (): Promise<Response> =>
      fakeResponse(
        { error: { code: 100, message: "Invalid event" } },
        false,
        400,
      );
    await expect(
      postConversionEvents("act_999", [{ eventName: "LEAD", eventTime: "2026-01-01T00:00:00Z", actionSource: "WEB", eventId: "e1" }], "tok", {
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(MetaGraphError);
  });
});