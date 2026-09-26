import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { loadEnv } from "@admedic/config";
import {
  appSecretProof,
  exchangeUserToken,
  getAppAccessToken,
  getGrantedPermissions,
  getTokenDebug,
  graphAuth,
  MOCK_GRANTED_PERMISSIONS,
} from "./token";
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

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null;
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? record[key]! : null;
}

describe("token yardımcıları", () => {
  it("getTokenDebug app token'ı Bearer başlığında, input_token'ı sorguda gönderir ve alanları yorumlar", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
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
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(
      "https://graph.facebook.com/v26.0/debug_token",
    );
    expect(url.searchParams.get("input_token")).toBe("tok");
    expect(url.searchParams.get("access_token")).toBeNull();
    expect(headerOf(calls[0]!.init, "authorization")).toBe("Bearer app_123|secret_abc");
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

  it("appSecretProof HMAC-SHA256(token, app_secret) üretir; secret yoksa undefined", () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const expected = createHmac("sha256", "secret_abc").update("tok_1").digest("hex");
    expect(appSecretProof("tok_1")).toBe(expected);
    expect(appSecretProof("tok_1", "other")).toBe(
      createHmac("sha256", "other").update("tok_1").digest("hex"),
    );
    const auth = graphAuth("tok_1");
    expect(auth.headers.Authorization).toBe("Bearer tok_1");
    expect(auth.params.appsecret_proof).toBe(expected);
    loadEnv({ fresh: true, overrides: { ...envOverrides, META_APP_SECRET: "" } });
    expect(appSecretProof("tok_1")).toBeUndefined();
    expect(graphAuth("tok_1").params).toEqual({});
  });

  it("getGrantedPermissions /me/permissions'ı Bearer + appsecret_proof ile okur ve sayfalar", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      if (calls.length === 1)
        return fakeResponse(
          {
            data: [
              { permission: "ads_read", status: "granted" },
              { permission: "leads_retrieval", status: "declined" },
              { permission: "instagram_basic", status: "expired" },
            ],
            paging: { next: "https://graph.facebook.com/v26.0/me/permissions?after=abc" },
          },
          true,
          200,
        );
      return fakeResponse(
        { data: [{ permission: "ads_management", status: "granted" }], paging: {} },
        true,
        200,
      );
    };
    const result = await getGrantedPermissions("tok_1", {
      mock: false,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(calls).toHaveLength(2);
    const first = new URL(calls[0]!.url);
    expect(first.origin + first.pathname).toBe("https://graph.facebook.com/v26.0/me/permissions");
    expect(first.searchParams.get("access_token")).toBeNull();
    expect(first.searchParams.get("appsecret_proof")).toBe(appSecretProof("tok_1"));
    expect(headerOf(calls[0]!.init, "authorization")).toBe("Bearer tok_1");
    expect(headerOf(calls[1]!.init, "authorization")).toBe("Bearer tok_1");
    expect(result.granted).toEqual(["ads_read", "ads_management"]);
    expect(result.declined).toEqual(["leads_retrieval"]);
    expect(result.expired).toEqual(["instagram_basic"]);
  });

  it("getGrantedPermissions mock modda ağ çağrısı yapmadan tam izin setini döndürür", async () => {
    loadEnv({ fresh: true, overrides: { ...envOverrides, META_MOCK_MODE: "true" } });
    const fetchFn = async (): Promise<Response> => {
      throw new Error("mock modda ağ çağrısı olmamalı");
    };
    const result = await getGrantedPermissions("tok_1", { fetchFn: fetchFn as unknown as typeof fetch });
    expect(result.granted).toEqual([...MOCK_GRANTED_PERMISSIONS]);
    expect(result.granted).toContain("ads_management");
    expect(result.declined).toEqual([]);
    const custom = await getGrantedPermissions("tok_1", { mock: true, mockGranted: ["ads_read"] });
    expect(custom.granted).toEqual(["ads_read"]);
    loadEnv({ fresh: true });
  });
});
