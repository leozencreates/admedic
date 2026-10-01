import { loadEnv } from "@admedic/config";
import { AssistantEventSchema } from "../../../_lib/assistant/events";
import { findTool, toolAllowedFor } from "../../../_lib/assistant/registry";
import { recordVoiceSessionEnd } from "../../../_lib/assistant-usage";
import { requireActor, quota } from "../../../_lib/auth";
import { logAudit } from "../../../_lib/audit";
import { body, HttpError, respond, sameOrigin } from "../../../_lib/http";
import { hasSpendAuthority } from "../../../_lib/spend-authority";

export const maxDuration = 15;

/**
 * Sesli asistan olay kaydı (ADR-0028): araç sonucu (VOICE_TOOL_CALL), aydınlatma onayı (VOICE_CONSENT_GIVEN) ve oturum
 * sonu (VOICE_SESSION_ENDED: yalnızca süre, aylık dakika bütçesi için; Faz 5).
 * - Hız sınırı türe göre ayrıdır: `session_ended` kendi anahtarını kullanır (`voice-session-end:<userId>`, dakikada
 *   10), böylece araç olaylarıyla dolan `voice-event` sınırı oturum sonu kaydını düşürmez (bütçe eksik sayılmaz).
 * - `session_ended` yalnızca sunucunun verdiği, aynı kullanıcıya ait, henüz kapanmamış bir oturum için kabul edilir
 *   (`recordVoiceSessionEnd`: bilinmeyen 404, ikinci bildirim 409); süre açılıştan geçen süreyle de kırpılır.
 * Asıl değişikliğin kaydı zaten ilgili uç noktanın kendi denetim kaydındadır; bu kayıt yalnızca sesle tetiklendiğini
 * gösterir. Gövde şeması bilinmeyen alanları reddeder; konuşma metni saklanmaz.
 * - Kayıt istemcinin bildirimidir, sunucu doğrulaması değildir (`after.source = "client"`). Araç adı kayıtta
 *   (`registry.ts` `findTool`) olmalı ve bildirilen risk kayıttaki riskle aynı olmalıdır (aksi 400).
 * - `ok` / `error` / `cancelled` yalnızca rolün (ve R3'te taze okunan harcama yetkisinin) bağlayabileceği araç için
 *   kabul edilir (`toolAllowedFor`: aracın rol listesi + risk sınırı); aksi 403.
 * - `denied` her rol için kabul edilir (Faz 4): yetkisiz denemeler de (ör. izleyicinin R1, harcama yetkisi olmayanın R3
 *   denemesi) denetim kaydına düşer. `denied` bir işlemin yapıldığını göstermez; yalnızca reddedildiğini.
 */
export async function POST(request: Request) {
  return respond(async () => {
    const env = loadEnv();
    if (!env.VOICE_ASSISTANT_ENABLED || !env.ELEVENLABS_ASSISTANT_AGENT_ID)
      throw new HttpError(404, "Sesli asistan bu kurulumda etkin değil.");
    sameOrigin(request);
    const actor = await requireActor();
    const event = await body(request, AssistantEventSchema, { maxBytes: 2048 });
    if (event.type === "session_ended") await quota(`voice-session-end:${actor.userId}`, 10, 60);
    else await quota(`voice-event:${actor.userId}`, 30, 60);
    if (event.type === "consent_given") {
      await logAudit({
        actor,
        action: "VOICE_CONSENT_GIVEN",
        entityType: "VOICE_ASSISTANT",
        entityId: event.conversationId ?? null,
      });
    } else if (event.type === "session_ended") {
      // Aylık dakika bütçesi sayacı ve denetim satırı aynı işlemde yazılır (`assistant-usage.ts`).
      await recordVoiceSessionEnd(
        actor,
        { sessionRef: event.sessionRef!, durationSeconds: event.durationSeconds!, conversationId: event.conversationId },
        env,
      );
    } else {
      const def = findTool(event.tool!);
      if (!def) throw new HttpError(400, "Bilinmeyen araç.");
      if (def.risk !== event.risk) throw new HttpError(400, "Araç risk seviyesi kayıtla uyuşmuyor.");
      if (event.outcome !== "denied") {
        const canApproveSpend = event.risk === "R3" ? await hasSpendAuthority(actor) : false;
        if (!toolAllowedFor(def, actor.role, canApproveSpend)) throw new HttpError(403, "Bu işlem için yetkiniz yok.");
      }
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
