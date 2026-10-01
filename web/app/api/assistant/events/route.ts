import { loadEnv } from "@admedic/config";
import { AssistantEventSchema, riskAllowedFor } from "../../../_lib/assistant/events";
import { requireActor, quota } from "../../../_lib/auth";
import { logAudit } from "../../../_lib/audit";
import { body, HttpError, respond, sameOrigin } from "../../../_lib/http";
import { hasSpendAuthority } from "../../../_lib/spend-authority";

export const maxDuration = 15;

/**
 * Sesli asistan olay kaydı (ADR-0028): araç sonucu (VOICE_TOOL_CALL) ve aydınlatma onayı (VOICE_CONSENT_GIVEN).
 * Asıl değişikliğin kaydı zaten ilgili uç noktanın kendi denetim kaydındadır; bu kayıt yalnızca sesle tetiklendiğini
 * gösterir. Gövde şeması bilinmeyen alanları reddeder; konuşma metni saklanmaz.
 * - Kayıt istemcinin bildirimidir, sunucu doğrulaması değildir (`after.source = "client"`). Rolün hiç
 *   çalıştıramayacağı risk seviyesi 403 ile reddedilir; araç adının kayıtla karşılaştırılması Faz 2'de `registry.ts`
 *   ile gelir.
 */
export async function POST(request: Request) {
  return respond(async () => {
    const env = loadEnv();
    if (!env.VOICE_ASSISTANT_ENABLED || !env.ELEVENLABS_ASSISTANT_AGENT_ID)
      throw new HttpError(404, "Sesli asistan bu kurulumda etkin değil.");
    sameOrigin(request);
    const actor = await requireActor();
    await quota(`voice-event:${actor.userId}`, 30, 60);
    const event = await body(request, AssistantEventSchema, { maxBytes: 2048 });
    if (event.type === "consent_given") {
      await logAudit({
        actor,
        action: "VOICE_CONSENT_GIVEN",
        entityType: "VOICE_ASSISTANT",
        entityId: event.conversationId ?? null,
      });
    } else {
      const canApproveSpend = event.risk === "R3" ? await hasSpendAuthority(actor) : false;
      if (!riskAllowedFor(event.risk!, actor.role, canApproveSpend))
        throw new HttpError(403, "Bu işlem için yetkiniz yok.");
      await logAudit({
        actor,
        action: "VOICE_TOOL_CALL",
        entityType: "VOICE_ASSISTANT",
        entityId: event.entityRef ?? null,
        after: {
          tool: event.tool!,
          risk: event.risk!,
          outcome: event.outcome!,
          source: "client",
          ...(event.conversationId ? { conversationId: event.conversationId } : {}),
        },
      });
    }
    return { ok: true };
  });
}
