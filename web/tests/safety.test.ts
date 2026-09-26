import { randomBytes, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyWebhookSignature } from "../app/_lib/verify";
import { leadLookupHash, normalizePhone } from "../app/_lib/lead-hash";
import { buildCampaignPlan } from "../app/_lib/campaign-plan";

vi.mock("@admedic/config", () => ({ loadEnv: () => ({ META_MOCK_MODE: true }) }));
import { normalizeTemplateName, sendWhatsAppMessage, templateLanguageCode } from "../app/_lib/whatsapp";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("external action boundaries", () => {
  it("never calls WhatsApp in mock mode even when real credentials are configured", async () => {
    vi.stubEnv("WHATSAPP_TOKEN", randomBytes(16).toString("hex"));
    vi.stubEnv("WHATSAPP_API_URL", "https://example.invalid");
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    expect((await sendWhatsAppMessage({ phone: "fixture", language: "tr" }, "test")).id).toMatch(/^mock_/);
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects malformed signatures including trailing non-hex bytes", () => {
    const secret = randomBytes(32).toString("hex");
    const signature = "sha256=" + createHmac("sha256", secret).update("{}").digest("hex");
    expect(verifyWebhookSignature("{}", signature, secret)).toBe(true);
    expect(verifyWebhookSignature("{}", signature + "invalid", secret)).toBe(false);
    expect(verifyWebhookSignature("changed", signature, secret)).toBe(false);
  });
  it("normalizes contacts without crossing tenant boundaries", () => {
    const a = leadLookupHash({ orgId: "a", phone: "+90 (555) 000-0000", email: " TEST@example.invalid " });
    expect(a).toBe(leadLookupHash({ orgId: "a", phone: "00905550000000", email: "test@example.invalid" }));
    expect(a).not.toBe(leadLookupHash({ orgId: "b", phone: "+905550000000", email: "test@example.invalid" }));
    // Yerel TR yazımı (0…) uluslararası yazımla (+90…) aynı kişidir.
    expect(normalizePhone("0532 111 22 33")).toBe("905321112233");
    expect(leadLookupHash({ orgId: "a", phone: "0532 111 22 33" })).toBe(
      leadLookupHash({ orgId: "a", phone: "+90 532 111 22 33" }),
    );
    // Telefon varsa e-posta farklı olsa da eşleşir; telefon yoksa e-posta esas alınır.
    expect(leadLookupHash({ orgId: "a", phone: "+905550000000", email: "x@example.invalid" })).toBe(
      leadLookupHash({ orgId: "a", phone: "+905550000000", email: "y@example.invalid" }),
    );
    expect(leadLookupHash({ orgId: "a", email: " Foo@Example.invalid " })).toBe(
      leadLookupHash({ orgId: "a", email: "foo@example.invalid" }),
    );
    expect(leadLookupHash({ orgId: "a", email: "foo@example.invalid" })).not.toBe(
      leadLookupHash({ orgId: "a", phone: "+905550000000" }),
    );
    // Mesajlaşma kimlikleri telefon/e-postadan önceliklidir.
    expect(leadLookupHash({ orgId: "a", phone: "+905550000000", psid: "p1" })).toBe(
      leadLookupHash({ orgId: "a", psid: "p1" }),
    );
    expect(leadLookupHash({ orgId: "a", psid: "p1", igId: "ig1" })).toBe(leadLookupHash({ orgId: "a", igId: "ig1" }));
    expect(leadLookupHash({ orgId: "a" })).toBeNull();
  });
  it("normalizes WhatsApp template names and languages", () => {
    expect(normalizeTemplateName("Hosgeldiniz_TR")).toBe("hosgeldiniz_tr");
    expect(normalizeTemplateName("welcome_v2")).toBe("welcome_v2");
    expect(normalizeTemplateName("bad name")).toBeNull();
    expect(normalizeTemplateName("")).toBeNull();
    expect(templateLanguageCode("ar")).toBe("ar");
    expect(templateLanguageCode("TR")).toBe("tr");
    expect(templateLanguageCode("en-us")).toBe("en_US");
    expect(templateLanguageCode("")).toBe("tr");
  });
  it("blocks inverted and underage audiences", () => {
    const input = { objective: "MAX_CONVERSIONS" as const, dailyBudgetCents: 10000, markets: ["DE"], languages: ["DE"], conversionMethod: "whatsapp" as const };
    expect(buildCampaignPlan({ ...input, ageMin: 17 }).blocked).toBe(true);
    expect(buildCampaignPlan({ ...input, ageMin: 54, ageMax: 18 }).blocked).toBe(true);
    expect(buildCampaignPlan({ ...input, ageMin: 18, ageMax: 54, monthlyCapCents: 300000 }).blocked).toBe(false);
  });
});
