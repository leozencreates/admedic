import { prisma, type Prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES, quota } from "../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../_lib/http";
import { z } from "zod";
import { getLlmConfig, LLM_NOT_CONFIGURED_MESSAGE } from "@admedic/config";
import { logAudit } from "../../_lib/audit";
import {
  AnthropicProvider,
  BriefSchema,
  BriefLanguageEnum,
  BRIEF_LANGUAGES,
  LANGUAGE_LABELS,
  MAX_VARIATIONS,
  MIN_VARIATIONS,
  PROMPT_VERSION,
  type BriefLanguage,
  type GenerateResult,
} from "@admedic/llm";
import { enrichBriefWithProfile, maxRisk, policyFor, type StudioPolicy } from "../../_lib/studio-service";
import { withLlmLog } from "../../_lib/llm-log";
import type { PolicyRisk } from "@admedic/policy";

export const maxDuration = 60;

const CreativeSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    brief: BriefSchema.optional(),
    /** Hedeflenen reklam dilleri; boşsa brief dili. Dil başına ayrı üretim (çeviri değil yerelleştirme, spec 3.4). */
    languages: z.array(BriefLanguageEnum).max(BRIEF_LANGUAGES.length).default([]),
    variations: z.number().int().min(MIN_VARIATIONS).max(MAX_VARIATIONS).default(2),
  })
  .strict();

interface LanguageResult {
  language: BriefLanguage;
  variants: GenerateResult["variants"];
  instantForm: GenerateResult["instantForm"];
  whatsapp: GenerateResult["whatsapp"];
  policy: StudioPolicy;
}

export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const creatives = await prisma.creative.findMany({
      where: { workspaceId: actor.workspaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return {
      creatives: creatives.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        type: c.type,
        variations: c.variations,
        languages: c.languages,
        policyRisk: c.policyRisk,
        primaryText: c.primaryText,
        headline: c.headline,
        createdAt: c.createdAt,
      })),
    };
  });
}

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const input = await body(request, CreativeSchema);

    let results: LanguageResult[] = [];
    let brief: Prisma.InputJsonValue | undefined;
    let policyRisk: PolicyRisk | undefined;
    let policyReport: Prisma.InputJsonValue | undefined;
    let languages = [...new Set(input.languages)];

    if (input.brief) {
      const llm = getLlmConfig();
      if (!llm) throw new HttpError(503, LLM_NOT_CONFIGURED_MESSAGE);
      languages = languages.length > 0 ? languages : [input.brief.language];
      // Dil başına bir üretim = bir kota birimi; kota üretime başlamadan önce ayrılır (stüdyo ile aynı saatlik limit).
      for (let i = 0; i < languages.length; i++) await quota(`ai:${actor.workspaceId}`, 20, 3600);
      const enriched = await enrichBriefWithProfile(input.brief, actor.workspaceId);
      const provider = new AnthropicProvider(llm.apiKey, llm.model);
      results = await Promise.all(
        languages.map(async (language): Promise<LanguageResult> => {
          const localized = { ...enriched, language };
          let generated: GenerateResult;
          try {
            generated = await withLlmLog({
              workspaceId: actor.workspaceId,
              agent: "creative-writer",
              promptVersion: PROMPT_VERSION,
              model: llm.model,
              run: () => provider.generate(localized, { variations: input.variations }),
            });
          } catch {
            throw new HttpError(
              502,
              `AI ${LANGUAGE_LABELS[language]} için geçerli kreatif üretemedi. Model/anahtar ayarını kontrol edin veya tekrar deneyin.`,
            );
          }
          const policy = await policyFor(generated, actor.workspaceId);
          return {
            language,
            variants: generated.variants,
            instantForm: generated.instantForm,
            whatsapp: generated.whatsapp,
            policy,
          };
        }),
      );
      policyRisk = results.map((r) => r.policy.risk).reduce(maxRisk, "LOW");
      policyReport = {
        risk: policyRisk,
        languages: Object.fromEntries(results.map((r) => [r.language, r.policy])),
      } as unknown as Prisma.InputJsonValue;
      brief = {
        input: enriched,
        languages,
        variations: input.variations,
        content: {
          variants: Object.fromEntries(results.map((r) => [r.language, r.variants])),
          instantForm: Object.fromEntries(results.map((r) => [r.language, r.instantForm])),
          whatsapp: Object.fromEntries(results.map((r) => [r.language, r.whatsapp])),
        },
      } as unknown as Prisma.InputJsonValue;
    }

    const primary = results[0]?.variants[0];
    const creative = await prisma.creative.create({
      data: {
        workspaceId: actor.workspaceId,
        orgId: actor.orgId,
        name: input.name,
        status: "DRAFT",
        type: "IMAGE",
        primaryText: primary?.text,
        headline: primary?.headline,
        description: primary?.description,
        cta: primary?.cta,
        languages,
        variations: input.variations,
        brief,
        policyRisk,
        policyReport,
      },
    });
    await logAudit({
      actor,
      action: "CREATIVE_CREATED",
      entityType: "CREATIVE",
      entityId: creative.id,
      after: {
        name: creative.name,
        status: creative.status,
        type: creative.type,
        hasBrief: !!input.brief,
        languages: creative.languages,
        variations: creative.variations,
        policyRisk: creative.policyRisk,
      },
    });
    return {
      creative: {
        id: creative.id,
        name: creative.name,
        status: creative.status,
        type: creative.type,
        variations: creative.variations,
        languages: creative.languages,
        policyRisk: creative.policyRisk,
        primaryText: creative.primaryText,
        headline: creative.headline,
        description: creative.description,
      },
      policy: policyRisk ? { risk: policyRisk, report: policyReport } : null,
      preview: primary
        ? { headline: primary.headline, text: primary.text, cta: primary.cta }
        : undefined,
      results,
    };
  });
}
