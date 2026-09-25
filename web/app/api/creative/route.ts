import { prisma, type Prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../_lib/auth";
import { body, respond, sameOrigin } from "../../_lib/http";
import { z } from "zod";
import { loadEnv } from "@admedic/config";
import { logAudit } from "../../_lib/audit";
import { AnthropicProvider, BriefSchema, BriefLanguageEnum } from "@admedic/llm";
import { enrichBriefWithProfile, policyFor } from "../../_lib/studio-service";

export const maxDuration = 60;

const CreativeSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    brief: BriefSchema.optional(),
    languages: z.array(BriefLanguageEnum).max(10).default([]),
    variations: z.number().int().min(2).max(4).default(2),
  })
  .strict();

let _provider: AnthropicProvider | null = null;
function getProvider(): AnthropicProvider {
  if (!_provider) {
    const env = loadEnv();
    const key = process.env.ANTHROPIC_API_KEY ?? env.LLM_API_KEY ?? "";
    _provider = new AnthropicProvider(
      key,
      process.env.LLM_MODEL ?? env.LLM_MODEL ?? "claude-sonnet-4",
    );
  }
  return _provider;
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
    loadEnv();

    let primaryText: string | undefined;
    let headline: string | undefined;
    let description: string | undefined;
    let cta: string | undefined;
    let brief: Prisma.InputJsonValue | undefined;
    let policyRisk: string | null | undefined;
    let policyReport: Prisma.InputJsonValue | undefined;
    let preview: { headline: string; text: string; cta: string } | undefined;

    if (input.brief) {
      const key = process.env.ANTHROPIC_API_KEY;
      const model = process.env.LLM_MODEL;
      if (!key || !model) throw new Error("AI için ANTHROPIC_API_KEY ve LLM_MODEL ayarlanmalı.");
      const enriched = await enrichBriefWithProfile(input.brief, actor.workspaceId);
      const provider = getProvider();
      const result = await provider.generate(enriched);
      primaryText = result.variants[0].text;
      headline = result.variants[0].headline;
      description = result.variants[0].description;
      cta = result.variants[0].cta;
      preview = {
        headline: result.variants[0].headline,
        text: result.variants[0].text,
        cta: result.variants[0].cta,
      };
      const content = {
        ...enriched,
        variants: result.variants,
        ...(result.instantForm ? { instantForm: result.instantForm } : {}),
        ...(result.whatsapp ? { whatsapp: result.whatsapp } : {}),
      };
      const policy = await policyFor(content, actor.workspaceId);
      policyRisk = policy.risk;
      policyReport = policy as Prisma.InputJsonValue;
      brief = {
        input: enriched,
        variants: result.variants,
        ...(result.instantForm ? { instantForm: result.instantForm } : {}),
        ...(result.whatsapp ? { whatsapp: result.whatsapp } : {}),
      } as Prisma.InputJsonValue;
    }

    const creative = await prisma.creative.create({
      data: {
        workspaceId: actor.workspaceId,
        orgId: actor.orgId,
        name: input.name,
        status: "DRAFT",
        type: "IMAGE",
        primaryText,
        headline,
        description,
        cta,
        languages: input.languages,
        variations: input.variations,
        brief,
        policyRisk: (policyRisk as "LOW" | "MEDIUM" | "HIGH" | null) ?? undefined,
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
      policy: policyRisk
        ? { risk: policyRisk, report: policyReport }
        : null,
      preview,
    };
  });
}