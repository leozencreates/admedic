import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { AnthropicProvider, BriefSchema, PROMPT_VERSION } from "@admedic/llm";
import {
  requireActor,
  requireRole,
  EDIT_ROLES,
  quota,
} from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { policyFor } from "../../../_lib/studio-service";
export const maxDuration = 60;
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const brief = await body(request, BriefSchema.strict());
    loadEnv();
    const key = process.env.ANTHROPIC_API_KEY;
    const model = process.env.LLM_MODEL;
    if (!key || !model)
      throw new HttpError(
        503,
        "AI için ANTHROPIC_API_KEY ve LLM_MODEL sunucuda ayarlanmalı.",
      );
    await quota(`ai:${actor.workspaceId}`, 20, 3600);
    const started = Date.now();
    const log = await prisma.llmCallLog.create({
      data: {
        workspaceId: actor.workspaceId,
        agent: "creative-writer",
        model,
        promptVersion: PROMPT_VERSION,
      },
    });
    try {
      const result = await new AnthropicProvider(key, model).generate(brief);
      await prisma.llmCallLog.update({
        where: { id: log.id },
        data: {
          status: "SUCCESS",
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: Date.now() - started,
        },
      });
      const content = { ...brief, variants: result.variants };
      const policy = await policyFor(content);
      return { content, policy };
    } catch {
      await prisma.llmCallLog.update({
        where: { id: log.id },
        data: { status: "FAILED", durationMs: Date.now() - started },
      });
      throw new HttpError(
        502,
        "AI geçerli reklam üretemedi. Model/anahtar ayarını kontrol edin veya tekrar deneyin.",
      );
    }
  });
}
