import { loadEnv } from "@admedic/config";
import { prisma } from "@admedic/database";
import { applyVoiceEvent, parseElevenLabsEvent, verifyElevenLabsSignature } from "@admedic/voice";
import { HttpError, respond } from "../../../_lib/http";

/**
 * ElevenLabs arama sonu webhook'u (ADR-0026).
 * - İmza (`ElevenLabs-Signature`) ham gövde üzerinden doğrulanır; gizli anahtar ayarlı değilse her istek 401
 *   (fail-closed).
 * - Olay idempotent işlenir: aynı konuşma yeniden teslim edilirse ikinci kez yazılmaz.
 * - Tanınmayan olay ya da bilinmeyen konuşma 200 `{ ignored: true }` döner (yeniden deneme tetiklenmesin);
 *   işleme hatası 503 döner ve ElevenLabs yeniden dener (webhook ayarında yeniden deneme açıksa).
 */
export const maxDuration = 30;

/** Transkript gövdesi büyük olabilir; ses olayı (base64) abone olunmadığı için beklenmez. */
const MAX_BODY_BYTES = 5_000_000;

export async function POST(request: Request) {
  return respond(async () => {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "İstek çok büyük.");
    const signature = request.headers.get("elevenlabs-signature");
    if (!verifyElevenLabsSignature(raw, signature, loadEnv().ELEVENLABS_WEBHOOK_SECRET))
      throw new HttpError(401, "Webhook imzası doğrulanamadı.");
    const result = await applyVoiceEvent(prisma, parseElevenLabsEvent(raw));
    return result.handled ? { ok: true } : { ignored: true };
  });
}
