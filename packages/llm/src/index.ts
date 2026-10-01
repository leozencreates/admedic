import { z } from "zod";
import { creativeSystemPrompt, LOCALIZATION, PROMPT_VERSION } from "../prompts/creative-v1";
import { POLICY_RISK_PROMPT_VERSION, POLICY_RISK_SYSTEM } from "../prompts/policy-risk-v1";
import {
  GREETING_PROMPT_VERSION,
  GREETING_USER_MESSAGE,
  greetingSystemPrompt,
} from "../prompts/greeting-v1";
import { anthropicMessages, extractJson, type LlmConfigLike, type LlmUsage } from "./anthropic";
import { BriefLanguageEnum, type BriefLanguage } from "./languages";
import { MetaCtaEnum, normalizeCta } from "./cta";

export * from "./languages";
export * from "./cta";
export * from "./anthropic";
export * from "./logging";
export * from "./assistant";
export {
  PROMPT_VERSION,
  PROMPT_VERSION as CREATIVE_PROMPT_VERSION,
  POLICY_RISK_PROMPT_VERSION,
  GREETING_PROMPT_VERSION,
  LOCALIZATION,
  creativeSystemPrompt,
};
export { leadAssistantSystemPrompt } from "../prompts/lead-assistant-v1";
export {
  LEAD_TEAM_PROMPT_VERSION,
  LEAD_TEAM_RULES,
  directorSystemPrompt,
  specialistSystemPrompt,
  teamLeadSystemPrompt,
} from "../prompts/lead-team-v1";

/** Klinik profili (spec 3.2): üretim bağlamı — sunucu tarafında DB'den zenginleştirilir. */
export const BriefProfileSchema = z
  .object({
    brandTone: z.string().max(2000).optional(),
    languages: z.array(BriefLanguageEnum).optional(),
    targetMarket: z
      .enum(["TURKEY", "GERMANY", "UK", "NETHERLANDS", "USA", "GULF", "OTHER"])
      .optional(),
    services: z.array(z.string().min(1).max(100)).optional(),
    bannedPhrases: z.array(z.string().min(2).max(200)).optional(),
  })
  .strict();

export const BriefSchema = z.object({
  clinic: z.string().trim().min(1).max(100),
  service: z.string().trim().min(1).max(100),
  market: z.string().trim().min(1).max(80),
  language: BriefLanguageEnum,
  budget: z.number().positive().max(1_000_000).finite(),
  duration: z.number().int().min(1).max(90),
  profile: BriefProfileSchema.optional(),
});
/** Kaydedilen taslak varyantı: CTA serbest metin kalır (eski taslaklarla uyum). */
export const VariantSchema = z
  .object({
    headline: z.string().trim().min(1).max(150),
    text: z.string().trim().min(1).max(2000),
    description: z.string().trim().max(500).optional(), // Meta description (link description)
    cta: z.string().trim().min(1).max(150),
  })
  .strict();
/** LLM çıktısı varyantı: CTA Meta `call_to_action` türüne normalize edilir. */
export const OutputVariantSchema = VariantSchema.extend({
  cta: z.string().trim().min(1).max(150).transform(normalizeCta).pipe(MetaCtaEnum),
});
export type OutputVariant = z.infer<typeof OutputVariantSchema>;
export const InstantFormSchema = z
  .object({
    questions: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
  })
  .strict();
export const WhatsAppSchema = z
  .object({ welcome: z.string().trim().min(1).max(2000) })
  .strict();

const SINGLE_VARIABLE_MESSAGE = "Başlıklar farklı, metin/description/CTA aynı olmalı.";
/** Tek değişkenli test (ADR-0004): yalnızca başlık değişir, başlıklar birbirinden farklıdır. */
export function isSingleVariable(variants: ReadonlyArray<{ headline: string; text: string; description?: string; cta: string }>) {
  const first = variants[0];
  if (!first) return false;
  const headlines = new Set(variants.map((v) => v.headline));
  return (
    headlines.size === variants.length &&
    variants.every((v) => v.text === first.text && v.description === first.description && v.cta === first.cta)
  );
}

/** Spec 3.4 çıktıları: N başlık varyantı (2–4) + Instant Form soruları + WhatsApp karşılaması (ikisi de zorunlu). */
export function outputSchemaFor(variations: number) {
  return z
    .object({
      variants: z.array(OutputVariantSchema).length(variations),
      instantForm: InstantFormSchema,
      whatsapp: WhatsAppSchema,
    })
    .strict()
    .refine(({ variants }) => isSingleVariable(variants), SINGLE_VARIABLE_MESSAGE);
}
export const OutputSchema = outputSchemaFor(2);
export type CreativeOutput = z.infer<typeof OutputSchema>;

export const DraftSchema = BriefSchema.extend({
  variants: z.tuple([VariantSchema, VariantSchema]),
  instantForm: InstantFormSchema.optional(),
  whatsapp: WhatsAppSchema.optional(),
}).strict();
export type DraftContent = z.infer<typeof DraftSchema>;
export type Brief = z.infer<typeof BriefSchema>;

/**
 * LLM politika katmanı (spec 3.5 katman 2): Meta Advertising Standards'a göre
 * risk skoru + gerekçe + düzeltilmiş metin önerisi. Kural motoruyla birleştirilir.
 */
export const PolicyRiskSchema = z
  .object({
    risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
    reason: z.string().trim().min(1).max(1000),
    correctedCopy: z.string().trim().max(2000).optional(),
  })
  .strict();
export type PolicyRiskAssessment = z.infer<typeof PolicyRiskSchema>;

export async function classifyRisk(
  adCopy: string,
  config: LlmConfigLike,
  transport: typeof fetch = fetch,
): Promise<PolicyRiskAssessment & { usage: LlmUsage }> {
  const { text, usage } = await anthropicMessages({
    ...config,
    system: POLICY_RISK_SYSTEM,
    messages: [{ role: "user", content: adCopy }],
    maxTokens: 1000,
    transport,
    errorMessage: "AI politika risk değerlendirmesi yanıt veremedi.",
  });
  return { ...PolicyRiskSchema.parse(extractJson(text)), usage };
}

export interface GenerateOptions {
  /** Başlık varyasyonu sayısı (2–4). */
  variations?: number;
}
export interface GenerateResult {
  variants: OutputVariant[];
  instantForm: z.infer<typeof InstantFormSchema>;
  whatsapp: z.infer<typeof WhatsAppSchema>;
  usage: LlmUsage;
}
export interface CreativeProvider {
  generate(brief: Brief, options?: GenerateOptions): Promise<GenerateResult>;
}

export const MIN_VARIATIONS = 2;
export const MAX_VARIATIONS = 4;
export function clampVariations(value: number | undefined): number {
  const n = Math.round(value ?? MIN_VARIATIONS);
  return Math.min(MAX_VARIATIONS, Math.max(MIN_VARIATIONS, Number.isFinite(n) ? n : MIN_VARIATIONS));
}

export class AnthropicProvider implements CreativeProvider {
  constructor(
    private key: string,
    private model: string,
    private transport: typeof fetch = fetch,
  ) {}
  async generate(brief: Brief, options: GenerateOptions = {}): Promise<GenerateResult> {
    const variations = clampVariations(options.variations);
    const { text, usage, stopReason } = await anthropicMessages({
      apiKey: this.key,
      model: this.model,
      system: `${creativeSystemPrompt(variations)}\n${LOCALIZATION[brief.language]}`,
      messages: [{ role: "user", content: JSON.stringify(brief) }],
      maxTokens: 2500 + (variations - 2) * 300,
      transport: this.transport,
    });
    if (stopReason !== "end_turn")
      throw new Error("AI çıktısı tamamlanmadı (kesildi). Tekrar deneyin.");
    const result = outputSchemaFor(variations).parse(extractJson(text));
    return { ...result, usage };
  }
}

export type GreetingLanguageCode = BriefLanguage;

/**
 * Spec 3.8: Yeni lead'e kendi dilinde otomatik karşılama. Ad-copy üreticisinden
 * (OutputSchema) ayrı, yalnızca karşılama metni döndüren özel üretim hattı.
 */
export async function generateGreetingWithUsage(
  config: LlmConfigLike,
  language: string,
  transport: typeof fetch = fetch,
): Promise<{ text: string; usage: LlmUsage }> {
  const { text, usage } = await anthropicMessages({
    ...config,
    system: greetingSystemPrompt(language),
    messages: [{ role: "user", content: GREETING_USER_MESSAGE }],
    maxTokens: 400,
    timeoutMs: 30_000,
    transport,
    errorMessage: "AI karşılama mesajı üretemedi. Ayarları kontrol edin.",
  });
  const message = text.replace(/^[\s"']+|[\s"']+$/g, "");
  if (!message) throw new Error("AI boş karşılama üretti.");
  return { text: message.slice(0, 300), usage };
}

/** Geriye dönük imza (webhook karşılaması): yalnızca metni döndürür. */
export async function generateGreeting(
  key: string,
  model: string,
  language: string,
  transport: typeof fetch = fetch,
): Promise<string> {
  return (await generateGreetingWithUsage({ apiKey: key, model }, language, transport)).text;
}
