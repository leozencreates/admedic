import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { ElevenLabsVoiceClient, MockVoiceClient, VoiceApiError, missingVoiceConfig } from "./client";
import { firstMessage, voiceLanguage } from "./disclosure";
import {
  MAX_CALL_ATTEMPTS,
  callBlockers,
  normalizeE164,
  withinCallWindow,
  zonesForNumber,
  type CallFacts,
} from "./eligibility";
import { parseElevenLabsEvent, verifyElevenLabsSignature } from "./webhook";

/** 2026-10-01 10:00 UTC: İstanbul 13:00, Berlin 12:00, Londra 11:00, New York 06:00, Los Angeles 03:00, Dubai 14:00. */
const NOON = new Date("2026-10-01T10:00:00Z");

const ok: CallFacts = {
  status: "NEW",
  phone: "+90 532 123 45 67",
  callConsent: true,
  humanOwned: false,
  attempts: 0,
  lastAttemptAt: null,
  activeCall: false,
  reached: false,
};

describe("telefon ve saat dilimi", () => {
  it("E.164'e çevirir; ülke kodu olmayan numarayı tahmin etmez", () => {
    expect(normalizeE164("+90 (532) 123-45-67")).toBe("+905321234567");
    expect(normalizeE164("0049 151 1234567")).toBe("+491511234567");
    expect(normalizeE164("0532 123 45 67")).toBeNull();
    expect(normalizeE164("+0123456789")).toBeNull();
    expect(normalizeE164("")).toBeNull();
    expect(normalizeE164(null)).toBeNull();
  });

  it("en uzun ülke kodunu eşler; bilinmeyen ülke null", () => {
    expect(zonesForNumber("+905321234567")).toEqual(["Europe/Istanbul"]);
    expect(zonesForNumber("+971501234567")).toEqual(["Asia/Dubai"]);
    expect(zonesForNumber("+3531234567")).toEqual(["Europe/Dublin"]);
    expect(zonesForNumber("+12125550100")).toEqual(["America/Los_Angeles", "America/New_York"]);
    expect(zonesForNumber("+79161234567")).toBeNull();
  });

  it("birden çok dilimli ülkede her dilimde saat uygun olmalı", () => {
    expect(withinCallWindow(NOON, ["Europe/Istanbul"])).toBe(true);
    expect(withinCallWindow(NOON, ["America/Los_Angeles", "America/New_York"])).toBe(false);
    // 18:00 UTC: New York 14:00, Los Angeles 11:00.
    expect(withinCallWindow(new Date("2026-10-01T18:00:00Z"), ["America/Los_Angeles", "America/New_York"])).toBe(true);
    // Sınırlar: 09:00 dahil, 20:00 hariç (İstanbul UTC+3).
    expect(withinCallWindow(new Date("2026-10-01T06:00:00Z"), ["Europe/Istanbul"])).toBe(true);
    expect(withinCallWindow(new Date("2026-10-01T05:59:00Z"), ["Europe/Istanbul"])).toBe(false);
    expect(withinCallWindow(new Date("2026-10-01T17:00:00Z"), ["Europe/Istanbul"])).toBe(false);
  });
});

describe("müsait lead kuralı", () => {
  it("koşulların hepsi sağlanınca engel yoktur", () => {
    expect(callBlockers(ok, "MANUAL", NOON)).toEqual([]);
    expect(callBlockers(ok, "AUTO", NOON)).toEqual([]);
  });

  it("rıza yoksa aranmaz", () => {
    expect(callBlockers({ ...ok, callConsent: false }, "MANUAL", NOON)).toEqual(["NO_CALL_CONSENT"]);
  });

  it("aşama, devralma, telefon ve saat engelleri", () => {
    expect(callBlockers({ ...ok, status: "CONSULTATION_BOOKED" }, "MANUAL", NOON)).toEqual(["STAGE"]);
    expect(callBlockers({ ...ok, status: "LOST" }, "AUTO", NOON)).toEqual(["STAGE"]);
    expect(callBlockers({ ...ok, humanOwned: true }, "AUTO", NOON)).toEqual(["HUMAN_OWNED"]);
    expect(callBlockers({ ...ok, phone: null }, "MANUAL", NOON)).toEqual(["NO_PHONE"]);
    expect(callBlockers({ ...ok, phone: "0532 123 45 67" }, "MANUAL", NOON)).toEqual(["INVALID_PHONE"]);
    expect(callBlockers({ ...ok, phone: "+79161234567" }, "MANUAL", NOON)).toEqual(["UNKNOWN_TIMEZONE"]);
    expect(callBlockers({ ...ok, phone: "+12125550100" }, "MANUAL", NOON)).toEqual(["OUTSIDE_HOURS"]);
    expect(callBlockers(ok, "MANUAL", new Date("2026-10-01T20:00:00Z"))).toEqual(["OUTSIDE_HOURS"]);
  });

  it("deneme sınırı, bekleme ve süren arama", () => {
    expect(callBlockers({ ...ok, attempts: MAX_CALL_ATTEMPTS }, "MANUAL", NOON)).toEqual(["MAX_ATTEMPTS"]);
    const recent = new Date(NOON.getTime() - 23 * 3600_000);
    expect(callBlockers({ ...ok, attempts: 1, lastAttemptAt: recent }, "MANUAL", NOON)).toEqual(["TOO_SOON"]);
    const old = new Date(NOON.getTime() - 25 * 3600_000);
    expect(callBlockers({ ...ok, attempts: 1, lastAttemptAt: old }, "MANUAL", NOON)).toEqual([]);
    expect(callBlockers({ ...ok, activeCall: true }, "MANUAL", NOON)).toEqual(["CALL_IN_PROGRESS"]);
  });

  it("ajanın görüştüğü lead otomatik aranmaz, elle aranabilir", () => {
    expect(callBlockers({ ...ok, reached: true }, "AUTO", NOON)).toEqual(["ALREADY_REACHED"]);
    expect(callBlockers({ ...ok, reached: true }, "MANUAL", NOON)).toEqual([]);
  });
});

describe("açılış cümlesi", () => {
  it("her dilde yapay zekâ bildirimi, ad ve klinik adı içerir", () => {
    const tr = firstMessage("tr", { name: "Ayşe", clinic: "Örnek Klinik" });
    expect(tr).toContain("Ayşe");
    expect(tr).toContain("Örnek Klinik");
    expect(tr).toContain("yapay zekâ");
    expect(tr).toContain("kaydedilmektedir");
    expect(firstMessage("de", { name: "Erika", clinic: "K" })).toContain("KI-Sprachassistent");
    expect(firstMessage("en", { name: "Ann", clinic: "K" })).toContain("AI voice assistant");
    expect(firstMessage("ar", { name: "A", clinic: "K" })).toContain("الذكاء الاصطناعي");
  });

  it("desteklenmeyen dilde İngilizceye düşer", () => {
    expect(voiceLanguage("TR")).toBe("tr");
    expect(voiceLanguage("de-DE")).toBe("de");
    expect(voiceLanguage("und")).toBe("en");
    expect(voiceLanguage(null)).toBe("en");
  });
});

describe("webhook imzası", () => {
  const secret = "wsec_test";
  const body = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_1" } });
  const nowMs = Date.parse("2026-10-01T10:00:00Z");
  const sign = (timestamp: number, payload = body, key = secret) =>
    `t=${timestamp},v0=${createHmac("sha256", key).update(`${timestamp}.${payload}`).digest("hex")}`;

  it("doğru imzayı kabul eder", () => {
    expect(verifyElevenLabsSignature(body, sign(nowMs / 1000), secret, nowMs)).toBe(true);
  });

  it("gövde, anahtar ya da zaman uyuşmazsa reddeder", () => {
    const t = nowMs / 1000;
    expect(verifyElevenLabsSignature(`${body} `, sign(t), secret, nowMs)).toBe(false);
    expect(verifyElevenLabsSignature(body, sign(t, body, "other"), secret, nowMs)).toBe(false);
    expect(verifyElevenLabsSignature(body, sign(t - 31 * 60), secret, nowMs)).toBe(false);
    expect(verifyElevenLabsSignature(body, sign(t + 31 * 60), secret, nowMs)).toBe(false);
  });

  it("gizli anahtar ya da başlık yoksa reddeder (fail-closed)", () => {
    const t = nowMs / 1000;
    expect(verifyElevenLabsSignature(body, sign(t), "", nowMs)).toBe(false);
    expect(verifyElevenLabsSignature(body, sign(t), undefined, nowMs)).toBe(false);
    expect(verifyElevenLabsSignature(body, null, secret, nowMs)).toBe(false);
    expect(verifyElevenLabsSignature(body, "v0=abc", secret, nowMs)).toBe(false);
    expect(verifyElevenLabsSignature(body, `t=${t},v0=zz`, secret, nowMs)).toBe(false);
  });
});

describe("webhook olayı", () => {
  it("transkript olayını sadeleştirir", () => {
    const event = parseElevenLabsEvent(
      JSON.stringify({
        type: "post_call_transcription",
        event_timestamp: 1790000000,
        data: {
          conversation_id: "conv_1",
          status: "done",
          metadata: { call_duration_secs: 92.4, termination_reason: "end_call tool was called" },
          analysis: { call_successful: "success", transcript_summary: "Lead geri aranmak istedi." },
          conversation_initiation_client_data: { dynamic_variables: { call_ref: "call_abc" } },
        },
      }),
    );
    expect(event).toEqual({
      type: "transcript",
      conversationId: "conv_1",
      callRef: "call_abc",
      status: "done",
      outcome: "success",
      summary: "Lead geri aranmak istedi.",
      durationSecs: 92,
      terminationReason: "end_call tool was called",
    });
  });

  it("arama başlatma hatasını sadeleştirir", () => {
    expect(
      parseElevenLabsEvent(
        JSON.stringify({ type: "call_initiation_failure", data: { conversation_id: "conv_2", failure_reason: "no-answer" } }),
      ),
    ).toEqual({ type: "initiation_failure", conversationId: "conv_2", callRef: null, failureReason: "no-answer" });
  });

  it("tanınmayan ya da bozuk gövdeyi yok sayar", () => {
    expect(parseElevenLabsEvent("{")).toEqual({ type: "ignored", reason: "invalid_json" });
    expect(parseElevenLabsEvent(JSON.stringify({ type: "post_call_audio", data: {} }))).toEqual({ type: "ignored", reason: "unsupported_type" });
    expect(parseElevenLabsEvent(JSON.stringify({ type: "post_call_transcription", data: {} }))).toEqual({
      type: "ignored",
      reason: "missing_conversation_id",
    });
  });
});

describe("ElevenLabs istemcisi", () => {
  const env = {
    ELEVENLABS_API_KEY: "key_test",
    ELEVENLABS_AGENT_ID: "agent_1",
    ELEVENLABS_PHONE_NUMBER_ID: "phone_1",
    ELEVENLABS_TELEPHONY: "twilio" as const,
    ELEVENLABS_API_BASE: "https://api.elevenlabs.io",
  };
  const input = {
    toNumber: "+905321234567",
    language: "tr",
    firstMessage: "Merhaba",
    dynamicVariables: { call_ref: "call_1", lead_first_name: "Ayşe", clinic_name: "Klinik", language: "tr" },
  };

  it("Twilio ucuna belgelenen gövdeyle istek atar", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ success: true, message: "ok", conversation_id: "conv_9", callSid: "CA123" }),
    );
    const placed = await new ElevenLabsVoiceClient(env, fetchFn).placeCall(input);
    expect(placed).toEqual({ conversationId: "conv_9", providerCallId: "CA123" });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
    expect((init!.headers as Record<string, string>)["xi-api-key"]).toBe("key_test");
    expect(JSON.parse(init!.body as string)).toEqual({
      agent_id: "agent_1",
      agent_phone_number_id: "phone_1",
      to_number: "+905321234567",
      conversation_initiation_client_data: {
        dynamic_variables: input.dynamicVariables,
        conversation_config_override: { agent: { first_message: "Merhaba", language: "tr" } },
      },
    });
  });

  it("SIP trunk seçiliyken SIP ucunu kullanır", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ success: true, conversation_id: "conv_s", sip_call_id: "sip_7" }),
    );
    const placed = await new ElevenLabsVoiceClient({ ...env, ELEVENLABS_TELEPHONY: "sip_trunk" }, fetchFn).placeCall(input);
    expect(fetchFn.mock.calls[0]![0]).toBe("https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call");
    expect(placed.providerCallId).toBe("sip_7");
  });

  it("hata iletisi numara içermez; sınır ve sunucu hataları yeniden denenebilir", async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 429 }));
    const error = await new ElevenLabsVoiceClient(env, limited).placeCall(input).catch((e) => e);
    expect(error).toBeInstanceOf(VoiceApiError);
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(429);
    expect(error.message).not.toContain("905321234567");

    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 422 }));
    const second = await new ElevenLabsVoiceClient(env, rejected).placeCall(input).catch((e) => e);
    expect(second.retryable).toBe(false);

    const down = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNRESET"));
    const third = await new ElevenLabsVoiceClient(env, down).placeCall(input).catch((e) => e);
    expect(third).toBeInstanceOf(VoiceApiError);
    expect(third.retryable).toBe(true);
  });

  it("yapılandırma eksikse istek atmaz", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = new ElevenLabsVoiceClient({ ...env, ELEVENLABS_AGENT_ID: undefined }, fetchFn);
    expect(client.missingConfig).toEqual(["ELEVENLABS_AGENT_ID"]);
    await expect(client.placeCall(input)).rejects.toThrow(/ELEVENLABS_AGENT_ID/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(missingVoiceConfig({ ELEVENLABS_API_KEY: undefined, ELEVENLABS_AGENT_ID: undefined, ELEVENLABS_PHONE_NUMBER_ID: undefined })).toHaveLength(3);
  });

  it("deneme istemcisi dış istek yapmadan deterministik sonuç döner", async () => {
    const mock = new MockVoiceClient();
    expect(await mock.placeCall(input)).toEqual({ conversationId: "mock_conv_call_1", providerCallId: "mock_call_call_1" });
    expect(mock.mock).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });
});
