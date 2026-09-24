import { it, expect, vi } from "vitest";
import {
  AnthropicProvider,
  BriefSchema,
  classifyRisk,
  OutputSchema,
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
const payload = (text = JSON.stringify({ variants }), reason = "end_turn") =>
  Response.json({
    stop_reason: reason,
    content: [{ type: "text", text }],
    usage: { input_tokens: 50, output_tokens: 100 },
  });

it("uses configured model and target-language context with validated output", async () => {
  for (const language of ["TR", "EN", "DE", "RU", "AR"] as const) {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(payload());
    const result = await new AnthropicProvider(
      "test-placeholder",
      "model-from-env",
      transport,
    ).generate({ ...brief, language });
    expect(result.variants).toEqual(variants);
    const request = JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(request.model).toBe("model-from-env");
    expect(JSON.parse(request.messages[0].content).language).toBe(language);
    expect(request.system).toContain("untrusted brief data");
    expect(result.inputTokens).toBe(50);
  }
});
it("rejects malformed output, truncation, upstream errors and network failures", async () => {
  for (const response of [
    payload("not json"),
    payload(JSON.stringify({ variants }), "max_tokens"),
    new Response("secret upstream error", { status: 401 }),
    payload(JSON.stringify({ variants: [variants[0]] })),
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
it("enforces a single-variable experiment and validates brief limits", () => {
  expect(
    OutputSchema.safeParse({ variants: [variants[0], variants[0]] }).success,
  ).toBe(false);
  expect(
    OutputSchema.safeParse({
      variants: [variants[0], { ...variants[1], cta: "Different" }],
    }).success,
  ).toBe(false);
  expect(BriefSchema.safeParse({ ...brief, budget: -1 }).success).toBe(false);
  expect(BriefSchema.safeParse({ ...brief, language: "FR" }).success).toBe(
    false,
  );
});
it("classifies advertising copy risk with validated output and overrides", async () => {
  const payload = (text: string) =>
    Response.json({
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 5, output_tokens: 5 },
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
    "key",
    "model",
    transport,
  );
  expect(result.risk).toBe("HIGH");
  expect(result.reason).toContain("Kesin sonuç");
  for (const bad of [
    payload("not json"),
    payload(JSON.stringify({ risk: "asdf" })),
    new Response("boom", { status: 500 }),
  ]) {
    await expect(
      classifyRisk("x", "key", "model", vi.fn<typeof fetch>().mockResolvedValue(bad)),
    ).rejects.toThrow();
  }
});
