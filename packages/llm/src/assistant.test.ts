import { it, expect, vi } from "vitest";
import {
  buildAssistantReply,
  detectHandoff,
  handoffNotice,
  leadAlias,
  maskContact,
  toChatMessages,
  HANDOFF_NOTICE,
} from "./assistant";
import { BRIEF_LANGUAGES } from "./languages";

it("detects emergencies in all supported languages with word boundaries", () => {
  for (const text of ["acil", "ACİL yardım lazım", "acilen görüşmem lazım", "urgent", "It is urgent!", "dringend", "срочно", "Это срочно", "عاجل", "c'est urgent", "pilne", "to jest pilne", "spoed"]) {
    expect(detectHandoff(text, "TR").reason, text).toBe("emergency");
  }
  // Sözcük içi eşleşme yok: "send it" ≠ "end it", "bölüm" ≠ "ölüm".
  for (const text of ["send it", "please send it to me", "bölüm", "ikinci bölüm", "kocaman bir gülümseme", "tarihi sordum", "Ich möchte mehr erfahren"]) {
    expect(detectHandoff(text, "TR").reason, text).toBeNull();
  }
});

it("detects human requests and out-of-scope questions (price, medical suitability)", () => {
  expect(detectHandoff("Bir insanla konuşabilir miyim?", "TR").reason).toBe("human");
  expect(detectHandoff("Can I talk to a real person?", "EN").reason).toBe("human");
  expect(detectHandoff("Kann ich mit einem Mitarbeiter sprechen?", "DE").reason).toBe("human");
  expect(detectHandoff("Можно поговорить с человеком?", "RU").reason).toBe("human");
  expect(detectHandoff("أريد التحدث مع شخص حقيقي", "AR").reason).toBe("human");
  expect(detectHandoff("Saç ekimi fiyatı ne kadar?", "TR").reason).toBe("out_of_scope");
  expect(detectHandoff("How much does it cost?", "EN").reason).toBe("out_of_scope");
  expect(detectHandoff("Was kostet die Behandlung?", "DE").reason).toBe("out_of_scope");
  expect(detectHandoff("Сколько стоит имплантация?", "RU").reason).toBe("out_of_scope");
  expect(detectHandoff("Am I a candidate for this?", "EN").reason).toBe("out_of_scope");
  expect(detectHandoff("Ile kosztuje zabieg?", "PL").reason).toBe("out_of_scope");
  // Acil durum diğer nedenlerden önce gelir.
  expect(detectHandoff("Fiyat sormuyorum, acil durum var", "TR").reason).toBe("emergency");
  expect(detectHandoff("Merhaba, saç ekimi hakkında bilgi almak istiyorum.", "TR").reason).toBeNull();
  expect(detectHandoff("", "TR")).toEqual({ reason: null, matched: null });
});

it("provides a handoff notice per language and reason", () => {
  for (const language of BRIEF_LANGUAGES) {
    expect(HANDOFF_NOTICE[language].human.length).toBeGreaterThan(20);
    expect(HANDOFF_NOTICE[language].emergency.length).toBeGreaterThan(20);
  }
  expect(handoffNotice("de", "human")).toBe(HANDOFF_NOTICE.DE.human);
  expect(handoffNotice("xx", "emergency")).toBe(HANDOFF_NOTICE.TR.emergency);
});

it("masks e-mail and phone numbers and derives a short pseudonymous alias", async () => {
  const masked = maskContact("Bana ali.veli@example.com veya +90 532 123 45 67 / 0049-151-1234567 üzerinden ulaşın, 2 kişi 14:30");
  expect(masked).not.toContain("ali.veli@example.com");
  expect(masked).not.toContain("532");
  expect(masked).not.toContain("1234567");
  expect(masked).toContain("[e-posta]");
  expect(masked).toContain("[telefon]");
  expect(masked).toContain("2 kişi 14:30");
  const alias = await leadAlias("org_1", "lead_1");
  expect(alias).toMatch(/^[0-9a-f]{8}$/);
  expect(alias).toBe(await leadAlias("org_1", "lead_1"));
  expect(alias).not.toBe(await leadAlias("org_2", "lead_1"));
});

it("builds alternating chat messages, merging same-role turns and dropping a leading assistant turn", () => {
  const messages = toChatMessages([
    { role: "assistant", text: "Karşılama" },
    { role: "lead", text: "merhaba" },
    { role: "lead", text: "numaram 05321234567" },
    { role: "assistant", text: "Hangi hizmet?" },
    { role: "team", text: "Not" },
    { role: "lead", text: "saç ekimi" },
  ]);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(messages[0]!.content).toBe("merhaba\nnumaram [telefon]");
  expect(messages[1]!.content).toBe("Hangi hizmet?\nNot");
});

it("generates a reply in the lead's language without PII in the prompt and returns usage", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "\"Vielen Dank! Für welche Behandlung interessieren Sie sich?\"" }],
      usage: { input_tokens: 40, output_tokens: 15 },
    }),
  );
  const reply = await buildAssistantReply(
    {
      language: "DE",
      alias: "ab12cd34",
      channel: "WHATSAPP",
      clinic: { name: "Fixture Klinik", services: ["Haartransplantation"], languages: ["DE", "EN"] },
      consentText: "Aydınlatma metni",
      firstBotMessage: true,
      history: [{ role: "lead", text: "Hallo, meine E-Mail ist max@example.de" }],
    },
    { apiKey: "key", model: "model" },
    transport,
  );
  expect(reply.text).toBe("Vielen Dank! Für welche Behandlung interessieren Sie sich?");
  expect(reply.usage).toEqual({ inputTokens: 40, outputTokens: 15 });
  const request = JSON.parse(String(transport.mock.calls[0][1]?.body));
  expect(request.model).toBe("model");
  expect(request.system).toContain("ab12cd34");
  expect(request.system).toContain("Fixture Klinik");
  expect(request.system).toContain("Aydınlatma metni");
  expect(request.system).toContain("otomatik bir asistan");
  expect(JSON.stringify(request)).not.toContain("max@example.de");
  expect(request.messages[0].content).toContain("[e-posta]");
  await expect(
    buildAssistantReply({ language: "TR", alias: "x", history: [] }, { apiKey: "k", model: "m" }, transport),
  ).rejects.toThrow();
  await expect(
    buildAssistantReply(
      { language: "TR", alias: "x", history: [{ role: "lead", text: "selam" }] },
      { apiKey: "k", model: "m" },
      vi.fn<typeof fetch>().mockResolvedValue(new Response("boom", { status: 500 })),
    ),
  ).rejects.toThrow();
});
