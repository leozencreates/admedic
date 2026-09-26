import { afterAll, describe, expect, it } from "vitest";

import { loadEnv } from "@admedic/config";
import { AdmedicError } from "@admedic/shared";
import {
  buildServerEvent,
  eventIdFor,
  hashUserData,
  healthAllowedEvents,
  LEAD_STATUS_EVENT,
  normalizePhone,
  postConversionEvents,
  sanitizeConversionInput,
  sha256,
  toMetaEventName,
  toUnixSeconds,
} from "./capi";
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

const NOW_ISO = new Date().toISOString();

afterAll(() => {
  loadEnv({ fresh: true });
});

describe("capi yardımcısı", () => {
  it("healthAllowedEvents huni olaylarını döndürür; her biri Meta standart adına eşlenir", () => {
    const allowed = healthAllowedEvents();
    expect(allowed).toEqual(["LEAD", "SCHEDULE", "COMPLETE_REGISTRATION", "CONTACT", "PURCHASE"]);
    expect(allowed).not.toContain("INVALID_EVENT");
    expect(toMetaEventName("LEAD")).toBe("Lead");
    expect(toMetaEventName("Lead")).toBe("Lead");
    expect(toMetaEventName("CONSULTATION_BOOKED")).toBeNull();
    expect(LEAD_STATUS_EVENT.CONSULTATION_BOOKED).toBe("SCHEDULE");
    expect(LEAD_STATUS_EVENT.TREATED).toBe("PURCHASE");
    expect(LEAD_STATUS_EVENT.LOST).toBeNull();
  });

  it("toUnixSeconds ISO/Date/ms/s girdilerini tam sayı saniyeye çevirir", () => {
    const expected = Math.floor(Date.UTC(2026, 8, 26, 10, 0, 0) / 1000);
    expect(toUnixSeconds("2026-09-26T10:00:00.500Z")).toBe(expected);
    expect(toUnixSeconds(new Date("2026-09-26T10:00:00Z"))).toBe(expected);
    expect(toUnixSeconds(expected)).toBe(expected);
    expect(toUnixSeconds(expected * 1000 + 500)).toBe(expected);
    expect(() => toUnixSeconds("garbage")).toThrow(AdmedicError);
  });

  it("sanitizeConversionInput sağlık/CRM alanlarını atar; custom_data yalnızca value+currency", () => {
    const result = sanitizeConversionInput({
      event_name: "Lead",
      event_time: 1790503200,
      diagnosis: "x",
      user_data: { em: "h", ph: "h2", ct: "antalya", diagnosis: "z", client_user_agent: "ua", fbp: "x" },
      custom_data: { value: 1200, currency: "eur", service: "saç ekimi", status: "TREATED", leadId: "L1" },
    });
    expect(result).toEqual({
      event_name: "Lead",
      event_time: 1790503200,
      user_data: { em: "h", ph: "h2", client_user_agent: "ua" },
      custom_data: { value: 1200, currency: "EUR" },
    });
    expect(sanitizeConversionInput({ custom_data: { service: "x" } })).toEqual({});
  });

  it("buildServerEvent Meta adı, Unix saniye ve action_source doğrular", () => {
    const e = buildServerEvent({ eventName: "SCHEDULE", eventTime: NOW_ISO, actionSource: "chat", eventId: "evt_1" });
    expect(e.event_name).toBe("Schedule");
    expect(Number.isInteger(e.event_time)).toBe(true);
    expect(e.action_source).toBe("chat");
    expect(() => buildServerEvent({ eventName: "BOGUS", eventTime: NOW_ISO, actionSource: "chat", eventId: "e" })).toThrow(/olay adı/);
    expect(() => buildServerEvent({ eventName: "LEAD", eventTime: NOW_ISO, actionSource: "WEB" as never, eventId: "e" })).toThrow(/action_source/);
    expect(() => buildServerEvent({ eventName: "LEAD", eventTime: NOW_ISO, actionSource: "offline_conversion" as never, eventId: "e" })).toThrow(/action_source/);
    expect(() => buildServerEvent({ eventName: "LEAD", eventTime: "2026-01-01T00:00:00Z", actionSource: "email", eventId: "e" })).toThrow(/7 gün/);
  });

  it("postConversionEvents pixel id'li URL'ye Bearer başlığıyla gönderir ve yanıtı yorumlar", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return fakeResponse({ events_received: 1, messages: [], fbtrace_id: "trace_1" }, true, 200);
    };
    const result = await postConversionEvents(
      "123456789012345",
      [{ eventName: "LEAD", eventTime: NOW_ISO, actionSource: "system_generated", eventId: "evt_1", customData: { value: 10, currency: "EUR" } }],
      "tok",
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://graph.facebook.com/v26.0/123456789012345/events");
    expect(url.searchParams.has("access_token")).toBe(false);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    const body = JSON.parse(String(calls[0]!.init?.body)) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]!.event_name).toBe("Lead");
    expect(typeof body.data[0]!.event_time).toBe("number");
    expect(body.data[0]!.custom_data).toEqual({ value: 10, currency: "EUR" });
    expect(result.eventsReceived).toBe(1);
    expect(result.fbtraceId).toBe("trace_1");
    expect(result.mock).toBe(false);
    expect(result.data[0]).toEqual({ eventId: "evt_1", isEventDuplicated: false });
  });

  it("mock modda gerçek istek yapmaz ve deterministik yanıt döner", async () => {
    loadEnv({ fresh: true, overrides: { ...envOverrides, META_MOCK_MODE: "true" } });
    let called = false;
    const fetchFn = async (): Promise<Response> => { called = true; return fakeResponse({}, true, 200); };
    const events = [{ eventName: "PURCHASE", eventTime: NOW_ISO, actionSource: "physical_store" as const, eventId: "evt_9" }];
    const a = await postConversionEvents("px_1", events, "", { fetchFn: fetchFn as unknown as typeof fetch });
    const b = await postConversionEvents("px_1", events, "", { fetchFn: fetchFn as unknown as typeof fetch });
    expect(called).toBe(false);
    expect(a.mock).toBe(true);
    expect(a.eventsReceived).toBe(1);
    expect(a.fbtraceId).toBe(b.fbtraceId);
    expect(a.data[0]!.eventId).toBe("evt_9");
    // Geçersiz olay mock modda da reddedilir.
    await expect(postConversionEvents("px_1", [{ ...events[0]!, eventName: "NOPE" }], "")).rejects.toThrow(AdmedicError);
  });

  it("Meta hata yanıtı MetaGraphError'a çevrilir", async () => {
    loadEnv({ fresh: true, overrides: envOverrides });
    const fetchFn = async (): Promise<Response> => fakeResponse({ error: { code: 100, message: "Invalid event" } }, false, 400);
    await expect(
      postConversionEvents("999", [{ eventName: "LEAD", eventTime: NOW_ISO, actionSource: "website", eventId: "e1" }], "tok", {
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(MetaGraphError);
  });

  it("hashUserData: em/ph/fn/ln/country normalize + sha256; ct kullanılmaz; ip/ua hash'lenmez", () => {
    const data = hashUserData({
      email: "  Guest@Example.COM ",
      phone: "+49 (0)123 456789",
      firstName: "Ada-Nur",
      lastName: "YILMAZ",
      country: "de",
      externalId: "lookup-hash",
      clientIp: "203.0.113.5",
      clientUserAgent: "UA/1.0",
    });
    expect(data.em).toBe(sha256("guest@example.com"));
    expect(data.ph).toBe(sha256("490123456789"));
    expect(data.fn).toBe(sha256("adanur"));
    expect(data.ln).toBe(sha256("yilmaz"));
    expect(data.country).toBe(sha256("de"));
    expect(data).not.toHaveProperty("ct");
    expect(data.external_id).toBe("lookup-hash");
    expect(data.client_ip_address).toBe("203.0.113.5");
    expect(data.client_user_agent).toBe("UA/1.0");
    expect(normalizePhone("+90 532 111 22 33")).toBe("905321112233");
    expect(normalizePhone("0049 123")).toBe("49123");
    // Geçersiz ülke (3 harf) gönderilmez
    expect(hashUserData({ country: "DEU" })).toEqual({});
  });

  it("eventIdFor aynı lead+olay+gün için kararlıdır (idempotente)", () => {
    const d = new Date("2026-09-26T10:00:00Z");
    const a = eventIdFor({ prefix: "crm", leadId: "L1", eventName: "LEAD", date: d });
    const b = eventIdFor({ prefix: "crm", leadId: "L1", eventName: "lead", date: d });
    const other = eventIdFor({ prefix: "crm", leadId: "L1", eventName: "PURCHASE", date: d });
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(a).toBe("crm_L1_LEAD_20260926");
  });
});
