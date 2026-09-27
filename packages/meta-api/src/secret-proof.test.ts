import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadEnv } from "@admedic/config";
import { postConversionEvents } from "./capi";
import { MetaMarketingClient } from "./client";
import { graphGet, nextPageUrl } from "./http";
import { createMetaClient } from "./index";
import { getLeadgenData } from "./leadgen";
import { sendMessengerText } from "./messenger";
import { appSecretProof } from "./secret-proof";
import { getGrantedPermissions } from "./token";
import { sendWhatsAppMessage } from "./whatsapp";

/**
 * `appsecret_proof` (HMAC-SHA256(access_token, app_secret)) — "Require App Secret" açık uygulamada
 * sunucu tarafı her Graph çağrısında bulunmalıdır. Bu testler her taşıyıcının kanıtı doğru yere
 * koyduğunu ve secret yokken (ya da başka uygulamanın token'ı için) göndermediğini doğrular.
 */

const SECRET = "secret_abc";
const proofOf = (token: string, secret = SECRET) => createHmac("sha256", secret).update(token).digest("hex");

const envOverrides = {
  META_APP_ID: "app_123",
  META_APP_SECRET: SECRET,
  META_API_VERSION: "v26.0",
  META_MOCK_MODE: "false",
};

interface Call {
  url: string;
  init?: RequestInit;
}

function recorder(bodies: unknown[] | ((url: string) => unknown)) {
  const calls: Call[] = [];
  let i = 0;
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const body = typeof bodies === "function" ? bodies(url) : bodies[Math.min(i++, bodies.length - 1)];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

afterEach(() => {
  vi.restoreAllMocks();
  loadEnv({ fresh: true });
});

describe("appSecretProof", () => {
  it("HMAC-SHA256(token, secret) hex üretir; boş token veya secret'ta undefined", () => {
    expect(appSecretProof("tok", SECRET)).toBe(proofOf("tok"));
    expect(appSecretProof("tok", "")).toBeUndefined();
    expect(appSecretProof("", SECRET)).toBeUndefined();
  });
});

describe("MetaMarketingClient appsecret_proof", () => {
  it("secret verilince GET sorgusuna ve POST gövdesine doğru kanıtı ekler", async () => {
    const { calls, fetchFn } = recorder([{ data: [] }, { success: true }, { id: "900" }]);
    const client = new MetaMarketingClient({ version: "v26.0", fetchFn, appSecret: SECRET });
    await client.listCampaigns("act_111", "tok_user");
    await client.updateBudget({ entityType: "campaign", entityId: "c1", dailyBudgetCents: 5000 }, "tok_user");
    await client.createLeadForm("555", { name: "F" }, "tok_page");

    const get = new URL(calls[0]!.url);
    expect(get.searchParams.get("access_token")).toBe("tok_user");
    expect(get.searchParams.get("appsecret_proof")).toBe(proofOf("tok_user"));
    const post = calls[1]!.init?.body as URLSearchParams;
    expect(post.get("appsecret_proof")).toBe(proofOf("tok_user"));
    // Sayfa token'ıyla yapılan çağrıda kanıt o token'dan hesaplanır.
    const pagePost = calls[2]!.init?.body as URLSearchParams;
    expect(pagePost.get("access_token")).toBe("tok_page");
    expect(pagePost.get("appsecret_proof")).toBe(proofOf("tok_page"));
  });

  it("secret verilmezse kanıt gönderilmez (ortamdan okunmaz)", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const { calls, fetchFn } = recorder([{ data: [] }, { success: true }]);
    const client = new MetaMarketingClient({ version: "v26.0", fetchFn });
    await client.listCampaigns("act_111", "tok_user");
    await client.setStatus({ entityType: "campaign", entityId: "c1", status: "PAUSED" }, "tok_user");
    expect(new URL(calls[0]!.url).searchParams.has("appsecret_proof")).toBe(false);
    expect((calls[1]!.init?.body as URLSearchParams).has("appsecret_proof")).toBe(false);
  });

  it("createMetaClient gerçek istemciye META_APP_SECRET'ı geçirir", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const { calls, fetchFn } = recorder([{ data: [] }]);
    const client = createMetaClient({ mock: false, fetchFn });
    await client.listCampaigns("act_111", "tok_user");
    expect(new URL(calls[0]!.url).searchParams.get("appsecret_proof")).toBe(proofOf("tok_user"));
  });
});

describe("sayfalama (paging.next)", () => {
  it("nextPageUrl yalnızca Graph kökünü izler ve eksik kimlik parametrelerini taşır", () => {
    const carry = { access_token: "tok", appsecret_proof: "p1" };
    const added = new URL(nextPageUrl("https://graph.facebook.com/v26.0/act_1/campaigns?after=x", carry)!);
    expect(added.searchParams.get("after")).toBe("x");
    expect(added.searchParams.get("access_token")).toBe("tok");
    expect(added.searchParams.get("appsecret_proof")).toBe("p1");
    // Meta'nın bağlantıya koyduğu değer korunur.
    const kept = new URL(nextPageUrl("https://graph.facebook.com/v26.0/x?appsecret_proof=meta", carry)!);
    expect(kept.searchParams.get("appsecret_proof")).toBe("meta");
    // Başlıkla yetkilendirilen çağrıda token URL'ye eklenmez.
    const headerAuth = new URL(nextPageUrl("https://graph.facebook.com/v26.0/me/accounts?after=y", { appsecret_proof: "p1" })!);
    expect(headerAuth.searchParams.has("access_token")).toBe(false);
    expect(headerAuth.searchParams.get("appsecret_proof")).toBe("p1");
    expect(nextPageUrl("https://evil.example/v26.0/x?after=1", carry)).toBeNull();
    expect(nextPageUrl("http://graph.facebook.com/v26.0/x", carry)).toBeNull();
    expect(nextPageUrl("bozuk bağlantı", carry)).toBeNull();
    expect(nextPageUrl(undefined, carry)).toBeNull();
  });

  it("graphGet sonraki sayfaya kanıtı taşır, Graph dışı bağlantıyı izlemez", async () => {
    const { calls, fetchFn } = recorder((url) =>
      url.includes("after=2")
        ? { data: [{ id: "3" }], paging: { next: "https://evil.example/steal?after=3" } }
        : { data: [{ id: "1" }, { id: "2" }], paging: { next: "https://graph.facebook.com/v26.0/act_1/ads?after=2" } },
    );
    const rows = await graphGet<{ id: string }>(
      "v26.0",
      "act_1/ads",
      { access_token: "tok", appsecret_proof: proofOf("tok") },
      fetchFn,
    );
    expect(rows.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get("appsecret_proof")).toBe(proofOf("tok"));
  });

  it("getGrantedPermissions ikinci sayfada da kanıtı gönderir", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const { calls, fetchFn } = recorder([
      { data: [], paging: { next: "https://graph.facebook.com/v26.0/me/permissions?after=abc" } },
      { data: [], paging: {} },
    ]);
    await getGrantedPermissions("tok_1", { mock: false, fetchFn });
    expect(calls).toHaveLength(2);
    const second = new URL(calls[1]!.url);
    expect(second.searchParams.get("appsecret_proof")).toBe(proofOf("tok_1"));
    expect(second.searchParams.has("access_token")).toBe(false);
  });
});

describe("başlıkla yetkilendirilen uçlar", () => {
  it("Lead Ads: kanıt sorguda, token başlıkta; boş secret kanıtı kapatır", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const { calls, fetchFn } = recorder([{ id: "lg_1", field_data: [] }]);
    await getLeadgenData("lg_1", "tok_page", { fetchFn });
    await getLeadgenData("lg_1", "tok_page", { fetchFn, appSecret: "" });
    const withProof = new URL(calls[0]!.url);
    expect(withProof.searchParams.get("appsecret_proof")).toBe(proofOf("tok_page"));
    expect(withProof.searchParams.has("access_token")).toBe(false);
    expect(new URL(calls[1]!.url).searchParams.has("appsecret_proof")).toBe(false);
  });

  it("Conversions API: kanıt sorguda", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const { calls, fetchFn } = recorder([{ events_received: 1 }]);
    await postConversionEvents(
      "123456789012345",
      [{ eventName: "LEAD", eventTime: new Date().toISOString(), actionSource: "system_generated", eventId: "e1" }],
      "tok_user",
      { fetchFn },
    );
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v26.0/123456789012345/events");
    expect(url.searchParams.get("appsecret_proof")).toBe(proofOf("tok_user"));
  });

  it("Messenger Send API: kanıt sorguda; boş secret kanıtı kapatır", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ message_id: "m_1" }));
    await sendMessengerText({ token: "tok_page", targetId: "page-1", psid: "p", text: "Merhaba", fetchFn });
    await sendMessengerText({ token: "tok_page", targetId: "page-1", psid: "p", text: "Merhaba", fetchFn, appSecret: "" });
    const first = new URL(String(fetchFn.mock.calls[0]![0]));
    expect(first.pathname).toBe("/v26.0/page-1/messages");
    expect(first.searchParams.get("appsecret_proof")).toBe(proofOf("tok_page"));
    expect(first.searchParams.has("access_token")).toBe(false);
    expect(new URL(String(fetchFn.mock.calls[1]![0])).searchParams.has("appsecret_proof")).toBe(false);
  });

  it("WhatsApp: kanıt yalnızca bağlantı taşıyıcısında; ortam düzeyi token'a eklenmez", async () => {
    loadEnv({
      fresh: true,
      overrides: { ...envOverrides, WHATSAPP_API_URL: "https://graph.facebook.com/v26.0/999", WHATSAPP_TOKEN: "env_tok" },
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ messages: [{ id: "wamid.1" }] }));
    await sendWhatsAppMessage(
      {
        phone: "+905551112233",
        language: "tr",
        transport: { apiUrl: "https://graph.facebook.com/v26.0/111", token: "tok_conn", appsecretProof: proofOf("tok_conn") },
      },
      "Merhaba",
    );
    await sendWhatsAppMessage({ phone: "+905551112233", language: "tr" }, "Merhaba");
    const tenant = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(tenant.pathname).toBe("/v26.0/111/messages");
    expect(tenant.searchParams.get("appsecret_proof")).toBe(proofOf("tok_conn"));
    expect(String(fetchSpy.mock.calls[1]![0])).toBe("https://graph.facebook.com/v26.0/999/messages");
  });
});
