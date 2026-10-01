import { cookies } from "next/headers";
import { loadEnv } from "@admedic/config";
import { createAssistantSession } from "@admedic/voice";
import { requireActor, quota } from "../../../_lib/auth";
import { logAudit } from "../../../_lib/audit";
import { enforceVoiceSessionLimits, newVoiceSessionRef, VOICE_SESSION_STARTED } from "../../../_lib/assistant-usage";
import { HttpError, respond, sameOrigin } from "../../../_lib/http";
import { UI_LANG_COOKIE, parseLanguage } from "../../../_lib/i18n";
import { hasSpendAuthority } from "../../../_lib/spend-authority";

export const maxDuration = 15;

/**
 * Sesli komut asistanı oturumu (ADR-0028). Tarayıcıya yalnızca kısa ömürlü konuşma belirteci (WebRTC) ya da imzalı
 * URL (WebSocket) döner; ElevenLabs API anahtarı ve ajan kimliği sunucuda kalır (ajanda `enable_auth` açıktır).
 * - Bayrak kapalıysa ya da asistan ajanı tanımlı değilse uç yokmuş gibi 404 döner.
 * - Rol ve harcama yetkisi yalnızca istemcide araç listesini daraltmak içindir; her işlem kendi uç noktasında yeniden
 *   yetkilendirilir (asistan bir yetki sınırı değildir).
 * - Denetim kaydına konuşma metni yazılmaz; yalnızca oturumun açıldığı ve bağlantı türü.
 * - Sınırlar (ADR-0028 §9): kullanıcı başına saatte 20; kuruluş başına günlük oturum ve aylık dakika bütçesi
 *   (`assistant-usage.ts`). Yanıttaki `maxSessionSeconds` ile tarayıcı oturumu kibarca kapatır (ajanda da aynı sınır).
 * - Oturum kimliği (`sessionRef`) sunucuda üretilir ve açılış kaydına yazılır; tarayıcı oturum sonunu
 *   (`session_ended`) yalnızca bu kimlikle bildirebilir (bir kez, aynı kullanıcı; `recordVoiceSessionEnd`).
 */
export async function POST(request: Request) {
  return respond(async () => {
    const env = loadEnv();
    if (!env.VOICE_ASSISTANT_ENABLED || !env.ELEVENLABS_ASSISTANT_AGENT_ID)
      throw new HttpError(404, "Sesli asistan bu kurulumda etkin değil.");
    sameOrigin(request);
    const actor = await requireActor();
    await quota(`voice:${actor.userId}`, 20, 3600);
    // Kuruluşun aylık dakika bütçesi ve günlük oturum sınırı (Faz 5; aşılınca 429 ve sabit Türkçe ileti).
    await enforceVoiceSessionLimits(actor, env);
    const credential = await createAssistantSession({ env });
    const language = parseLanguage((await cookies()).get(UI_LANG_COOKIE)?.value);
    const sessionRef = newVoiceSessionRef();
    await logAudit({
      actor,
      action: VOICE_SESSION_STARTED,
      entityType: "VOICE_ASSISTANT",
      entityId: credential.connectionType === "webrtc" ? credential.conversationId : null,
      after: {
        connection: credential.connectionType,
        serverLocation: credential.serverLocation,
        language,
        mock: credential.mock,
        sessionRef,
      },
    });
    return {
      connection: credential.connectionType,
      ...(credential.connectionType === "webrtc"
        ? { conversationToken: credential.conversationToken, conversationId: credential.conversationId }
        : { signedUrl: credential.signedUrl }),
      serverLocation: credential.serverLocation,
      /** Deneme modu: belirteç sahtedir, istemci ElevenLabs yerine senaryolu bağdaştırıcıyı kullanır. */
      mock: credential.mock,
      // Uygulama adı koda yazılmaz (AGENTS.md).
      assistantName: env.ASSISTANT_NAME ?? env.APP_NAME,
      language,
      voiceId: env.ELEVENLABS_ASSISTANT_VOICE_ID ?? null,
      role: actor.role,
      canApproveSpend: await hasSpendAuthority(actor),
      /** Oturumun en uzun süresi (sn); ajanda `conversation.max_duration_seconds` ile aynı (eşitleme betiği). */
      maxSessionSeconds: env.VOICE_ASSISTANT_MAX_SESSION_SECONDS,
      /** Sunucunun verdiği oturum kimliği; oturum sonu (`session_ended`) yalnızca bununla kabul edilir. */
      sessionRef,
    };
  });
}
