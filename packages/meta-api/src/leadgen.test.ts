import { describe, expect, it } from "vitest";

import { loadEnv } from "@admedic/config";
import {
  getLeadgenData,
  getLeadgenDataMock,
  LEADGEN_FIELDS,
  normalizeLeadgenFields,
  parseDisclaimerResponses,
  parseLeadgenResponse,
} from "./leadgen";
import { LEAD_FORM_CONSENT_KEY } from "./publish";
import { MetaGraphError } from "./http";

function fakeResponse(bodyObj: unknown, ok: boolean, status: number): Response {
  return {
    async text(): Promise<string> {
      return JSON.stringify(bodyObj);
    },
    headers: new Headers(),
    ok,
    status,
    statusText: ok ? "OK" : "Error",
  } as unknown as Response;
}

const envOverrides = {
  META_APP_ID: "app_123",
  META_APP_SECRET: "secret_abc",
  META_API_VERSION: "v26.0",
  META_MOCK_MODE: "false",
};

describe("leadgen yardımcısı", () => {
  it("normalizeLeadgenFields standart alanları ayırır, diğerlerini answers'a koyar", () => {
    const normalized = normalizeLeadgenFields([
      { name: "email", values: ["Guest@Example.com"] },
      { name: "phone_number", values: ["+49 151 2345678"] },
      { name: "full_name", values: ["Ada Yılmaz"] },
      { name: "country", values: ["DE"] },
      { name: "city", values: ["Berlin"] },
      { name: "date_of_birth", values: ["1990-01-01"] },
      { name: "gender", values: ["female"] },
      { name: "which_treatment_are_you_interested_in?", values: ["Saç ekimi"] },
      { name: "empty", values: [""] },
    ]);
    expect(normalized.email).toBe("Guest@Example.com");
    expect(normalized.phone).toBe("+49 151 2345678");
    expect(normalized.fullName).toBe("Ada Yılmaz");
    expect(normalized.firstName).toBe("Ada");
    expect(normalized.lastName).toBe("Yılmaz");
    expect(normalized.country).toBe("DE");
    expect(normalized.city).toBe("Berlin");
    expect(normalized.answers).toEqual({
      "which_treatment_are_you_interested_in?": "Saç ekimi",
    });
    // Diğer PII alanları answers'a sızmaz.
    expect(normalized.answers).not.toHaveProperty("date_of_birth");
    expect(normalized.answers).not.toHaveProperty("gender");
  });

  it("parseLeadgenResponse sayısal kimlikleri string'e çevirir", () => {
    const parsed = parseLeadgenResponse(
      {
        id: 123,
        created_time: "2026-09-26T08:00:00+0000",
        ad_id: 456,
        adset_id: "789",
        campaign_id: 1011,
        form_id: 1213,
        field_data: [{ name: "email", values: ["a@b.c"] }],
      },
      "fallback",
    );
    expect(parsed.id).toBe("123");
    expect(parsed.adId).toBe("456");
    expect(parsed.adsetId).toBe("789");
    expect(parsed.campaignId).toBe("1011");
    expect(parsed.formId).toBe("1213");
    expect(parsed.normalized.email).toBe("a@b.c");
    expect(parseLeadgenResponse(null, "fallback").id).toBe("fallback");
  });

  it("getLeadgenData doğru URL'yi kurar ve token'ı Authorization başlığında taşır", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return fakeResponse(
        {
          id: "lg_1",
          created_time: "2026-09-26T08:00:00+0000",
          ad_id: "ad_1",
          adset_id: "adset_1",
          campaign_id: "cmp_1",
          form_id: "form_1",
          field_data: [
            { name: "email", values: ["guest@example.com"] },
            { name: "phone_number", values: ["+905321112233"] },
            { name: "first_name", values: ["Ada"] },
          ],
        },
        true,
        200,
      );
    };
    try {
      const data = await getLeadgenData("lg_1", "tok_secret", {
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      const url = new URL(calls[0]!.url);
      expect(url.origin + url.pathname).toBe("https://graph.facebook.com/v26.0/lg_1");
      expect(url.searchParams.get("fields")).toContain("field_data");
      expect(url.searchParams.get("access_token")).toBeNull();
      expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer tok_secret",
      );
      expect(data.adId).toBe("ad_1");
      expect(data.campaignId).toBe("cmp_1");
      expect(data.normalized.email).toBe("guest@example.com");
      expect(data.normalized.phone).toBe("+905321112233");
      expect(data.normalized.firstName).toBe("Ada");
    } finally {
      loadEnv({ fresh: true });
    }
  });

  it("Meta hata yanıtı MetaGraphError'a çevrilir", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const fetchFn = async (): Promise<Response> =>
      fakeResponse({ error: { code: 190, message: "Invalid OAuth access token" } }, false, 400);
    try {
      await expect(
        getLeadgenData("lg_1", "tok", { fetchFn: fetchFn as unknown as typeof fetch }),
      ).rejects.toThrow(MetaGraphError);
    } finally {
      loadEnv({ fresh: true });
    }
  });

  it("onay kutusu yanıtları custom_disclaimer_responses'tan okunur (is_checked \"1\" → işaretli)", () => {
    expect(LEADGEN_FIELDS.split(",")).toContain("custom_disclaimer_responses");
    const parsed = parseLeadgenResponse(
      {
        id: "lg_9",
        field_data: [],
        custom_disclaimer_responses: [
          { checkbox_key: "kvkk_consent", is_checked: "1" },
          { checkbox_key: "optional_2", is_checked: "" },
          { checkbox_key: "", is_checked: "1" },
          { is_checked: "1" },
        ],
      },
      "lg_9",
    );
    expect(parsed.disclaimerResponses).toEqual([
      { key: "kvkk_consent", checked: true },
      { key: "optional_2", checked: false },
    ]);
    // Alan yoksa (formda kutu yok) boş dizi; bozuk değer güvenle yok sayılır.
    expect(parseLeadgenResponse({ id: "x" }, "x").disclaimerResponses).toEqual([]);
    expect(parseDisclaimerResponses("bozuk")).toEqual([]);
    expect(parseDisclaimerResponses([{ checkbox_key: "a", is_checked: true }, { checkbox_key: "b", is_checked: "true" }])).toEqual([
      { key: "a", checked: true },
      { key: "b", checked: true },
    ]);
    expect(getLeadgenDataMock("lg_mock_consent").disclaimerResponses).toEqual([{ key: LEAD_FORM_CONSENT_KEY, checked: true }]);
  });

  it("getLeadgenDataMock deterministiktir ve normalize alanları doldurur", () => {
    const a = getLeadgenDataMock("lg_mock_1");
    const b = getLeadgenDataMock("lg_mock_1");
    const other = getLeadgenDataMock("lg_mock_2");
    expect(a).toEqual(b);
    expect(a.normalized.email).toContain("@example.invalid");
    expect(a.normalized.phone).toMatch(/^\+\d+$/);
    expect(a.normalized.firstName).toBeTruthy();
    expect(a.adId).toBeTruthy();
    expect(Object.keys(a.normalized.answers).length).toBeGreaterThan(0);
    expect(a.normalized.email).not.toBe(other.normalized.email);
  });
});
