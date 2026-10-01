import { describe, expect, it } from "vitest";
import { AssistantEventSchema } from "../app/_lib/assistant/events";
import {
  clampSessionDuration,
  CLIENT_END_GRACE_SECONDS,
  elapsedSessionSeconds,
  monthlyBudgetExhausted,
  monthStartUtc,
  reachedSessionLimit,
  SESSION_END_GRACE_SECONDS,
  sessionEndedEvent,
  sessionExpired,
  sessionMinutesLabel,
  sessionSecondsLeft,
  showSessionRemaining,
  VOICE_LIMIT_MESSAGES,
  voiceLimitKind,
} from "../app/_lib/assistant/limits";
import { t } from "../app/_lib/i18n";
import {
  ASSISTANT_SILENCE_END_SECONDS,
  buildAgentPatch,
  DEFAULT_MAX_SESSION_SECONDS,
  MAX_DURATION_MESSAGE,
  syncAgent,
} from "../scripts/elevenlabs-sync-agent";

// Faz 5 (ADR-0028 §9): oturum süresi, oturum sonu bildirimi ve kuruluş sınırlarının saf kuralları.

describe("oturum süresi (istemci)", () => {
  const start = 1_000_000;

  it("kalan süre yukarı yuvarlanır, 0'ın altına inmez; yalnızca son 30 sn gösterilir", () => {
    expect(sessionSecondsLeft(start, start, 300)).toBe(300);
    expect(sessionSecondsLeft(start, start + 270_500, 300)).toBe(30);
    expect(sessionSecondsLeft(start, start + 400_000, 300)).toBe(0);
    expect(showSessionRemaining(31)).toBe(false);
    expect(showSessionRemaining(30)).toBe(true);
    expect(showSessionRemaining(1)).toBe(true);
    expect(showSessionRemaining(0)).toBe(false);
  });

  it("tarayıcı sınırdan kısa bir pay sonra kapatır (ajanın süre sonu iletisi kesilmesin)", () => {
    expect(sessionExpired(start, start + 300_000, 300)).toBe(false);
    expect(sessionExpired(start, start + (300 + CLIENT_END_GRACE_SECONDS) * 1000, 300)).toBe(true);
  });

  it("sınıra yakın kopma süre sınırı sayılır; erken kopma ya da sınır yoksa sayılmaz", () => {
    expect(reachedSessionLimit(start, start + 296_000, 300)).toBe(true);
    expect(reachedSessionLimit(start, start + 200_000, 300)).toBe(false);
    expect(reachedSessionLimit(null, start + 400_000, 300)).toBe(false);
    expect(reachedSessionLimit(start, start + 400_000, null)).toBe(false);
  });

  it("süre sınırı iletisi dakikayı dilin biçimiyle yazar", () => {
    expect(sessionMinutesLabel(300, "tr")).toBe("5");
    expect(sessionMinutesLabel(90, "tr")).toBe("1,5");
    expect(sessionMinutesLabel(90, "en")).toBe("1.5");
    expect(t("assistant.session.timeLimit", "tr")).toContain("{minutes}");
    expect(t("assistant.session.timeLimit", "en")).toContain("{minutes}");
    expect(t("assistant.session.remaining", "tr")).toContain("{seconds}");
  });
});

describe("oturum sonu olayı (session_ended)", () => {
  it("bağlantı kurulmadıysa ya da sunucu oturum kimliği yoksa olay yok; süre tam sayı, kimlik yalnızca güvenli biçimde", () => {
    const ref = "a".repeat(32);
    expect(sessionEndedEvent(null, 5_000, ref, "conv_1")).toBeNull();
    expect(sessionEndedEvent(1_000, 5_000, null, "conv_1")).toBeNull();
    expect(sessionEndedEvent(1_000, 5_000, "bad ref", "conv_1")).toBeNull();
    expect(sessionEndedEvent(1_000, 126_400, ref, "conv_1")).toEqual({
      type: "session_ended",
      sessionRef: ref,
      durationSeconds: 125,
      conversationId: "conv_1",
    });
    expect(sessionEndedEvent(1_000, 2_000, ref, "bad id with spaces")).toEqual({ type: "session_ended", sessionRef: ref, durationSeconds: 1 });
    expect(sessionEndedEvent(1_000, 500, ref, null)).toEqual({ type: "session_ended", sessionRef: ref, durationSeconds: 0 });
    expect(elapsedSessionSeconds(null, 10_000)).toBe(0);
  });

  it("üretilen olay sunucu şemasından geçer (sıkı şema)", () => {
    const event = sessionEndedEvent(0, 86_400_000 * 2, "b".repeat(32), "conv_1");
    expect(event?.durationSeconds).toBe(86_400);
    expect(AssistantEventSchema.safeParse(event).success).toBe(true);
    expect(AssistantEventSchema.safeParse({ ...event, text: "x" }).success).toBe(false);
  });

  it("sunucu süreyi en çok max + 30 sn sayar; negatif ve NaN sıfırdır", () => {
    expect(clampSessionDuration(125.4, 300)).toBe(125);
    expect(clampSessionDuration(10_000, 300)).toBe(300 + SESSION_END_GRACE_SECONDS);
    expect(clampSessionDuration(-5, 300)).toBe(0);
    expect(clampSessionDuration(Number.NaN, 300)).toBe(0);
  });
});

describe("kuruluş sınırları", () => {
  it("ay başı UTC; aylık bütçe 0 iken sınırsız", () => {
    expect(monthStartUtc(new Date("2026-10-31T23:59:59.000Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(monthStartUtc(new Date("2026-01-01T00:00:00.000Z")).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(monthlyBudgetExhausted(1_000_000, 0)).toBe(false);
    expect(monthlyBudgetExhausted(599, 10)).toBe(false);
    expect(monthlyBudgetExhausted(600, 10)).toBe(true);
  });

  it("429 iletileri tanınır ve iki dilde i18n karşılığı vardır; genel hız sınırı ayrı kalır", () => {
    expect(voiceLimitKind(VOICE_LIMIT_MESSAGES.dailySessions)).toBe("dailySessions");
    expect(voiceLimitKind(VOICE_LIMIT_MESSAGES.monthlyMinutes)).toBe("monthlyMinutes");
    expect(voiceLimitKind("Çok fazla deneme. Bir süre sonra tekrar deneyin.")).toBeNull();
    expect(t("assistant.error.dailyCap", "tr")).toBe(VOICE_LIMIT_MESSAGES.dailySessions);
    expect(t("assistant.error.monthlyCap", "tr")).toBe(VOICE_LIMIT_MESSAGES.monthlyMinutes);
    expect(t("assistant.error.dailyCap", "en")).not.toBe(VOICE_LIMIT_MESSAGES.dailySessions);
  });
});

describe("ajan süre ve sessizlik ayarları (eşitleme betiği)", () => {
  it("PATCH gövdesi en uzun süreyi, sessizlikte kapatmayı ve süre sonu iletisini taşır", () => {
    const patch = buildAgentPatch({ prompt: "p", llm: "m", toolIds: [], assistantName: "A", maxSessionSeconds: 240 });
    expect(patch.conversation_config.conversation).toEqual({ max_duration_seconds: 240 });
    expect(patch.conversation_config.turn).toEqual({ silence_end_call_timeout: ASSISTANT_SILENCE_END_SECONDS });
    expect(patch.conversation_config.agent.max_conversation_duration_message).toBe(MAX_DURATION_MESSAGE);
    // Kısmi `platform_settings` gövdesi diğer ayarları sıfırlayabilir; gönderilmez.
    expect(patch).not.toHaveProperty("platform_settings");
    expect(buildAgentPatch({ prompt: "p", llm: "m", toolIds: [], assistantName: "A" }).conversation_config.conversation.max_duration_seconds).toBe(
      DEFAULT_MAX_SESSION_SECONDS,
    );
  });

  it("aralık dışı süre gönderilmeden reddedilir", () => {
    for (const bad of [59, 1801, 120.5])
      expect(() => buildAgentPatch({ prompt: "p", llm: "m", toolIds: [], assistantName: "A", maxSessionSeconds: bad }), String(bad)).toThrow(
        /max_duration_seconds/,
      );
  });

  it("ajan yanıtındaki süre gönderilenden farklıysa eşitleme hata verir", async () => {
    const fetch = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return Response.json({ tools: [], has_more: false });
      if (url.includes("/v1/convai/tools")) return Response.json({ id: `t_${Math.random().toString(36).slice(2)}` });
      const body = JSON.parse(String(init?.body));
      return Response.json({
        conversation_config: {
          agent: { prompt: { tool_ids: body.conversation_config.agent.prompt.tool_ids, llm: "m" } },
          conversation: { max_duration_seconds: 600 },
        },
      });
    };
    await expect(
      syncAgent({ llm: "m", prompt: "p", assistantName: "A", dryRun: false, apiBase: "https://x.test", apiKey: "k", agentId: "g", fetch, log: () => {}, maxSessionSeconds: 300 }),
    ).rejects.toThrow(/max_duration_seconds \(600\)/);
  });
});
