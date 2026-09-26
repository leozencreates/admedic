import { getLlmConfig, LLM_NOT_CONFIGURED_MESSAGE } from "@admedic/config";
import {
  AnthropicProvider,
  BriefSchema,
  PROMPT_VERSION,
  type DraftContent,
} from "@admedic/llm";
import {
  requireActor,
  requireRole,
  EDIT_ROLES,
  quota,
} from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { policyFor, enrichBriefWithProfile } from "../../../_lib/studio-service";
import { withLlmLog } from "../../../_lib/llm-log";
export const maxDuration = 60;
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const brief = await body(request, BriefSchema.strict());
    const llm = getLlmConfig();
    if (!llm) throw new HttpError(503, LLM_NOT_CONFIGURED_MESSAGE);
    await quota(`ai:${actor.workspaceId}`, 20, 3600);
    const enriched = await enrichBriefWithProfile(brief, actor.workspaceId);
    // Yalnızca LLM çağrısı sarmalanır: sonraki kural/DB hataları günlüğü FAILED'a çevirmez.
    let result: Awaited<ReturnType<AnthropicProvider["generate"]>>;
    try {
      result = await withLlmLog({
        workspaceId: actor.workspaceId,
        agent: "creative-writer",
        promptVersion: PROMPT_VERSION,
        model: llm.model,
        run: () => new AnthropicProvider(llm.apiKey, llm.model).generate(enriched),
      });
    } catch {
      throw new HttpError(
        502,
        "AI geçerli reklam üretemedi. Model/anahtar ayarını kontrol edin veya tekrar deneyin.",
      );
    }
    const [a, b] = result.variants;
    if (!a || !b) throw new HttpError(502, "AI iki başlık varyantı üretemedi.");
    const content: DraftContent = {
      ...enriched,
      variants: [a, b],
      instantForm: result.instantForm,
      whatsapp: result.whatsapp,
    };
    const policy = await policyFor(content, actor.workspaceId);
    return { content, policy };
  });
}
