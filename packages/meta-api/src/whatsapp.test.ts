import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "@admedic/config";
import { normalizeTemplateName, sendWhatsAppMessage, templateLanguageCode } from "./whatsapp";
import { sendMessengerText } from "./messenger";

describe("WhatsApp Cloud API taşıyıcısı (paket kopyası)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    loadEnv({ fresh: true });
  });

  it("şablon adı ve dil kodunu Meta biçimine getirir", () => {
    expect(normalizeTemplateName("Hosgeldin_TR")).toBe("hosgeldin_tr");
    expect(normalizeTemplateName("bad name")).toBeNull();
    expect(templateLanguageCode("de")).toBe("de");
    expect(templateLanguageCode("en-US")).toBe("en_US");
    expect(templateLanguageCode("")).toBe("tr");
  });

  it("mock modda dış istek yapmaz; telefon yoksa hata döner", async () => {
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "true" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect((await sendWhatsAppMessage({ phone: "+905551112233", language: "tr" }, "Merhaba")).id).toMatch(/^mock_/);
    expect((await sendWhatsAppMessage({ phone: null, language: "tr" }, "Merhaba")).error).toContain("telefon");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gerçek modda API ayarı yoksa göndermez, ayar varsa metin yükü gönderir", async () => {
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "false", WHATSAPP_API_URL: "", WHATSAPP_TOKEN: "" } });
    expect((await sendWhatsAppMessage({ phone: "+905551112233", language: "tr" }, "Merhaba")).error).toContain("yapılandırılmamış");
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "false", WHATSAPP_API_URL: "https://wa.example.invalid/v1", WHATSAPP_TOKEN: "t" } });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ messages: [{ id: "wamid.1" }] }));
    const result = await sendWhatsAppMessage({ phone: "+905551112233", language: "de" }, "Hallo");
    expect(result.id).toBe("wamid.1");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://wa.example.invalid/v1/messages");
    expect(JSON.parse(String(init?.body))).toMatchObject({ messaging_product: "whatsapp", type: "text", text: { body: "Hallo" } });
  });
});

describe("Messenger Send API taşıyıcısı", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    loadEnv({ fresh: true });
  });

  it("mock modda dış istek yapmaz; boş metin ve uzun metin reddedilir", async () => {
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "true" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect((await sendMessengerText({ token: "t", psid: "p", text: "Merhaba" })).id).toMatch(/^mock_/);
    expect((await sendMessengerText({ token: "t", psid: "p", text: "  " })).error).toBeTruthy();
    expect((await sendMessengerText({ token: "t", psid: "p", text: "x".repeat(2001) })).error).toContain("2000");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gerçek modda token/psid ister ve Send API yükünü gönderir; Meta hatasını Türkçeye çevirir", async () => {
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "false", META_API_VERSION: "v26.0" } });
    expect((await sendMessengerText({ token: "t", psid: null, text: "Hallo" })).error).toContain("psid");
    expect((await sendMessengerText({ token: null, psid: "p", text: "Hallo" })).error).toContain("token");
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ message_id: "m_1" }));
    const ok = await sendMessengerText({ token: "t", targetId: "page-1", psid: "p", text: "Hallo", fetchFn: fetchSpy });
    expect(ok).toMatchObject({ id: "m_1", error: null, humanAgentTag: false });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://graph.facebook.com/v26.0/page-1/messages");
    expect(JSON.parse(String(init?.body))).toMatchObject({ recipient: { id: "p" }, messaging_type: "RESPONSE", message: { text: "Hallo" } });
    const denied = await sendMessengerText({
      token: "t",
      psid: "p",
      text: "Hallo",
      humanAgent: true,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ error: { code: 10, error_subcode: 2018278, message: "outside of allowed window" } }, { status: 400 }),
      ),
    });
    expect(denied.error).toContain("24 saatlik");
    expect(denied.humanAgentTag).toBe(true);
  });
});
