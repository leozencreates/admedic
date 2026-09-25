import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../_lib/auth";
import { body, respond, sameOrigin } from "../../_lib/http";
import { z } from "zod";
import { loadEnv } from "@admedic/config";
import { logAudit } from "../../_lib/audit";
import { AnthropicProvider } from "@admedic/llm";
import { BriefSchema } from "@admedic/llm";

export const maxDuration = 60;

const CreativeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  brief: BriefSchema.optional(),
}).strict();

let _provider: AnthropicProvider | null = null;
function getProvider(): AnthropicProvider {
  if (!_provider) {
    const env = loadEnv();
    _provider = new AnthropicProvider(
      env.LLM_API_KEY ?? "",
      env.LLM_MODEL ?? "claude-sonnet-4",
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
    return { creatives };
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

    if (input.brief) {
      const provider = getProvider();
      const result = await provider.generate(input.brief);
      primaryText = result.variants[0].text;
      headline = result.variants[0].headline;
      description = result.variants[0].description;
      cta = result.variants[0].cta;
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
      },
    });
    await logAudit({
      actor,
      action: "CREATIVE_CREATED",
      entityType: "CREATIVE",
      entityId: creative.id,
      after: { name: creative.name, status: creative.status, type: creative.type, hasBrief: !!input.brief },
    });
    return { creative: { id: creative.id, name: creative.name, status: creative.status, type: creative.type, primaryText: creative.primaryText, headline: creative.headline } };
  });
}
