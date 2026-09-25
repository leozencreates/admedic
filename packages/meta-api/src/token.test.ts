import { describe, expect, it } from "vitest";

import { loadEnv } from "@admedic/config";
import { exchangeUserToken, getAppAccessToken, getTokenDebug } from "./token";
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

describe("token yardımcıları", () => {
  it("getTokenDebug istek URL'sini ve alan yorumunu doğru yapar", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const calls: string[] = [];
    const fetchFn = async (url: string): Promise<Response> => {
      calls.push(url);
      return fakeResponse(
        {
          data: {
            is_valid: true,
            expires_at: 1893456000,
            scopes: ["ads_read", "business_management"],
            user_id: "user_9",
            app_id: "app_123",
          },
        },
        true,
        200,
      );
    };
    const result = await getTokenDebug("tok", "app_123|secret_abc", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const url = new URL(calls[0]!);
    expect(url.origin + url.pathname).toBe(
      "https://graph.facebook.com/v26.0/debug_token",
    );
    expect(url.searchParams.get("input_token")).toBe("tok");
    expect(url.searchParams.get("access_token")).toBe("app_123|secret_abc");
    expect(result.isValid).toBe(true);
    expect(result.expiresAt?.toISOString()).toBe(
      new Date(1893456000 * 1000).toISOString(),
    );
    expect(result.scopes).toEqual(["ads_read", "business_management"]);
    expect(result.userId).toBe("user_9");
  });

  it("exchangeUserToken fb_exchange_token isteğini kurar ve yeni token + expiresIn kullanır", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    let url = "";
    const fetchFn = async (u: string): Promise<Response> => {
      url = u;
      return fakeResponse(
        { access_token: "new_token_456", token_type: "bearer", expires_in: 5184000 },
        true,
        200,
      );
    };
    const result = await exchangeUserToken("old_token_123", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://graph.facebook.com/v26.0/oauth/access_token",
    );
    expect(parsed.searchParams.get("grant_type")).toBe("fb_exchange_token");
    expect(parsed.searchParams.get("client_id")).toBe("app_123");
    expect(parsed.searchParams.get("fb_exchange_token")).toBe("old_token_123");
    expect(result.accessToken).toBe("new_token_456");
    expect(result.expiresAt).not.toBeNull();
    expect(result.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("Meta hata yanıtı MetaGraphError'a çevrilir", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const fetchFn = async (): Promise<Response> =>
      fakeResponse(
        { error: { code: 190, message: "Invalid OAuth access token" } },
        false,
        400,
      );
    await expect(
      exchangeUserToken("dead_token", {
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(MetaGraphError);
  });

  it("getAppAccessToken app id ve secret olmadan hata fırlatır", () => {
    loadEnv({ fresh: true, overrides: { META_APP_ID: "", META_APP_SECRET: "" } });
    expect(() => getAppAccessToken()).toThrow(/META_APP_ID/);
  });
});