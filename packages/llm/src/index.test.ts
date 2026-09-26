import { it, expect, vi } from "vitest";
import {
  AnthropicProvider,
  BriefSchema,
  BRIEF_LANGUAGES,
  classifyRisk,
  DraftSchema,
  generateGreeting,
  generateGreetingWithUsage,
  LANGUAGE_LABELS,
  LOCALIZATION,
  OutputSchema,
  outputSchemaFor,
  POLICY_RISK_PROMPT_VERSION,
  GREETING_PROMPT_VERSION,
  LEAD_ASSISTANT_PROMPT_VERSION,
  PROMPT_VERSION,
  type Brief,
} from "./index";
const brief: Brief = {
  clinic: "Example",
  service: "Dental services",
  market: "UK",
  language: "EN",
  budget: 700,
  duration: 7,
};
const variants = [
  {
    headline: "Meet our team",
    text: "Learn about our services.",
    cta: "Learn more",
  },
  {
    headline: "Discover our services",
    text: "Learn about our services.",
    cta: "Learn more",
  },
];
const extras = {
  instantForm: { questions: ["Hizmeti seçin", "Ülkeniz?"] },
  whatsapp: { welcome: "Merhaba! Ben otomatik asistanım; hangi hizmetle ilgileniyorsunuz?" },
};
const outputs = { variants, ...extras };
const payload = (text = JSON.stringify(outputs), reason = "end_turn") =>
  Response.json({
    stop_reason: reason,
    content: [{ type: "text", text }],
    usage: { input_tokens: 50, output_tokens: 100 },
  });

it("exposes versioned prompts and one canonical language list", () => {
  expect(PROMPT_VERSION).toBe("creative-v1");
  expect(POLICY_RISK_PROMPT_VERSION).toBe("policy-risk-v1");
  expect(GREETING_PROMPT_VERSION).toBe("greeting-v1");
  expect(LEAD_ASSISTANT_PROMPT_VERSION).toBe("lead-assistant-v1");
  expect(BRIEF_LANGUAGES).toEqual(["TR", "EN", "DE", "RU", "AR", "FR", "NL", "PL"]);
  expect(Object.keys(LOCALIZATION).sort()).toEqual([...BRIEF_LANGUAGES].sort());
  expect(Object.keys(LANGUAGE_LABELS).sort()).toEqual([...BRIEF_LANGUAGES].sort());
});
it("uses configured model and target-language context with validated output and usage", async () => {
  for (const language of BRIEF_LANGUAGES) {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(payload());
    const result = await new AnthropicProvider(
      "test-placeholder",
      "model-from-env",
      transport,
    ).generate({ ...brief, language });
    // CTA serbest metni Meta CTA türüne normalize edilir; instantForm/whatsapp zorunlu çıktılardır.
    expect(result.variants.map((v) => v.headline)).toEqual(variants.map((v) => v.headline));
    expect(result.variants.every((v) => v.cta === "LEARN_MORE")).toBe(true);
    expect(result.instantForm).toEqual(extras.instantForm);
    expect(result.whatsapp).toEqual(extras.whatsapp);
    const request = JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(request.model).toBe("model-from-env");
    expect(JSON.parse(request.messages[0].content).language).toBe(language);
    expect(request.system).toContain("untrusted brief data");
    expect(request.system).toContain("exactly 2 variants");
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 100 });
  }
});
it("generates N headline variations on request (single-variable test kept)", async () => {
  const three = {
    variants: [
      { headline: "A", text: "Same text", cta: "BOOK_NOW" },
      { headline: "B", text: "Same text", cta: "BOOK_NOW" },
      { headline: "C", text: "Same text", cta: "BOOK_NOW" },
    ],
    ...extras,
  };
  const transport = vi.fn<typeof fetch>().mockResolvedValue(payload(JSON.stringify(three)));
  const result = await new AnthropicProvider("k", "m", transport).generate(brief, { variations: 3 });
  expect(result.variants).toHaveLength(3);
  expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).system).toContain("exactly 3 variants");
  // Üç istenip iki dönerse ya da başlıklar aynıysa reddedilir.
  await expect(
    new AnthropicProvider("k", "m", vi.fn<typeof fetch>().mockResolvedValue(payload())).generate(brief, { variations: 3 }),
  ).rejects.toThrow();
  expect(
    outputSchemaFor(3).safeParse({ ...three, variants: [three.variants[0], three.variants[0], three.variants[1]] }).success,
  ).toBe(false);
});
it("rejects malformed output, truncation, upstream errors, missing required outputs and network failures", async () => {
  for (const response of [
    payload("not json"),
    payload(JSON.stringify(outputs), "max_tokens"),
    new Response("secret upstream error", { status: 401 }),
    payload(JSON.stringify({ variants: [variants[0]], ...extras })),
    payload(JSON.stringify({ variants })),
    payload(JSON.stringify({ variants, instantForm: extras.instantForm })),
  ]) {
    await expect(
      new AnthropicProvider(
        "test-placeholder",
        "test-model",
        vi.fn<typeof fetch>().mockResolvedValue(response),
      ).generate(brief),
    ).rejects.toThrow();
  }
  await expect(
    new AnthropicProvider(
      "test-placeholder",
      "test-model",
      vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout")),
    ).generate(brief),
  ).rejects.toThrow();
});
it("tolerates fenced JSON in model output", async () => {
  const fenced = "Here you go:\n```json\n" + JSON.stringify(outputs) + "\n```";
  const result = await new AnthropicProvider(
    "k",
    "m",
    vi.fn<typeof fetch>().mockResolvedValue(payload(fenced)),
  ).generate(brief);
  expect(result.variants).toHaveLength(2);
});
it("enforces a single-variable experiment and validates brief limits", () => {
  expect(
    OutputSchema.safeParse({ variants: [variants[0], variants[0]], ...extras }).success,
  ).toBe(false);
  expect(
    OutputSchema.safeParse({
      variants: [variants[0], { ...variants[1], cta: "Book now" }],
      ...extras,
    }).success,
  ).toBe(false);
  expect(BriefSchema.safeParse({ ...brief, budget: -1 }).success).toBe(false);
  expect(BriefSchema.safeParse({ ...brief, language: "XX" }).success).toBe(
    false,
  );
  // Kaydedilen taslaklar (eski veriler dahil) serbest CTA metnini korur.
  expect(DraftSchema.safeParse({ ...brief, variants }).success).toBe(true);
});
it("generates a greeting in the lead's language via the greeting prompt (no ad-copy schema)", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ content: [{ type: "text", text: "Merhaba! 👋" }] }),
    );
  const message = await generateGreeting("key", "model", "DE", transport);
  expect(message).toBe("Merhaba! 👋");
  const request = JSON.parse(String(transport.mock.calls[0][1]?.body));
  expect(request.system).toContain("karşılama");
  expect(request.system).toContain("(DE)");
  expect(request.max_tokens).toBe(400);
  const detailed = await generateGreetingWithUsage(
    { apiKey: "key", model: "model" },
    "TR",
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ content: [{ type: "text", text: "Selam" }], usage: { input_tokens: 7, output_tokens: 3 } }),
    ),
  );
  expect(detailed).toEqual({ text: "Selam", usage: { inputTokens: 7, outputTokens: 3 } });
  await expect(
    generateGreeting(
      "key",
      "model",
      "DE",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("boom", { status: 500 })),
    ),
  ).rejects.toThrow();
  await expect(
    generateGreeting(
      "key",
      "model",
      "DE",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ content: [] })),
    ),
  ).rejects.toThrow();
});
it("classifies advertising copy risk with validated output, usage and overrides", async () => {
  const payload = (text: string) =>
    Response.json({
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 5, output_tokens: 6 },
    });
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      payload(
        JSON.stringify({
          risk: "HIGH",
          reason: "Kesin sonuç vaadi içeriyor.",
          correctedCopy: "Süreci öğrenmek için bilgi isteyin.",
        }),
      ),
    );
  const result = await classifyRisk(
    "Garantili sonuçlar",
    { apiKey: "key", model: "model" },
    transport,
  );
  expect(result.risk).toBe("HIGH");
  expect(result.reason).toContain("Kesin sonuç");
  expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  const request = JSON.parse(String(transport.mock.calls[0][1]?.body));
  expect(request.system).toContain("untrusted ad copy");
  for (const bad of [
    payload("not json"),
    payload(JSON.stringify({ risk: "asdf" })),
    new Response("boom", { status: 500 }),
  ]) {
    await expect(
      classifyRisk("x", { apiKey: "key", model: "model" }, vi.fn<typeof fetch>().mockResolvedValue(bad)),
    ).rejects.toThrow();
  }
});
