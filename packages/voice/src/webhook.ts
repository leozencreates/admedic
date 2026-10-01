import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ElevenLabs arama sonu webhook'u (ADR-0026): imza doğrulaması ve olayın sadeleştirilmesi.
 * İmza biçimi resmi dokümanda yazılı değildir; resmi SDK kaynağından alınmıştır
 * (docs/elevenlabs-constraints.md "Webhook imzası").
 */

/** İmzadaki zaman damgası bundan eskiyse istek reddedilir (yeniden oynatma koruması). */
export const SIGNATURE_TOLERANCE_MS = 30 * 60_000;

/**
 * `ElevenLabs-Signature: t=<unix saniye>,v0=<hex>`; imzalanan dizgi `<t>.<ham gövde>`, HMAC-SHA256.
 * Gizli anahtar ya da başlık yoksa başarısız sayılır (fail-closed); karşılaştırma sabit zamanlıdır.
 */
export function verifyElevenLabsSignature(
  rawBody: string,
  header: string | null,
  secret: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!secret || !header) return false;
  const parts = new Map(
    header.split(",").map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const;
    }),
  );
  const timestamp = parts.get("t") ?? "";
  const signature = parts.get("v0") ?? "";
  if (!/^\d{9,11}$/.test(timestamp) || !/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const ageMs = nowMs - Number(timestamp) * 1000;
  if (ageMs > SIGNATURE_TOLERANCE_MS || ageMs < -SIGNATURE_TOLERANCE_MS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const provided = Buffer.from(signature, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export type VoiceEvent =
  | {
      type: "transcript";
      conversationId: string;
      /** Panelin arama kaydı kimliği (`dynamic_variables.call_ref`); eski/yabancı aramada null. */
      callRef: string | null;
      /** Sağlayıcı konuşma durumu: done | failed | … */
      status: string;
      /** success | failure | unknown */
      outcome: string | null;
      summary: string | null;
      durationSecs: number | null;
      terminationReason: string | null;
    }
  | {
      type: "initiation_failure";
      conversationId: string;
      callRef: string | null;
      /** busy | no-answer | unknown */
      failureReason: string;
    }
  | { type: "ignored"; reason: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function callRefOf(data: Record<string, unknown>): string | null {
  const variables = record(record(data.conversation_initiation_client_data).dynamic_variables);
  return text(variables.call_ref);
}

/** Ham webhook gövdesini panelin kullandığı olaya çevirir; tanınmayan tür `ignored` döner. */
export function parseElevenLabsEvent(rawBody: string): VoiceEvent {
  let payload: Record<string, unknown>;
  try {
    payload = record(JSON.parse(rawBody));
  } catch {
    return { type: "ignored", reason: "invalid_json" };
  }
  const data = record(payload.data);
  const conversationId = text(data.conversation_id);
  if (payload.type === "post_call_transcription") {
    if (!conversationId) return { type: "ignored", reason: "missing_conversation_id" };
    const analysis = record(data.analysis);
    const metadata = record(data.metadata);
    const duration = metadata.call_duration_secs;
    return {
      type: "transcript",
      conversationId,
      callRef: callRefOf(data),
      status: text(data.status) ?? "done",
      outcome: text(analysis.call_successful),
      summary: text(analysis.transcript_summary),
      durationSecs: typeof duration === "number" && Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : null,
      terminationReason: text(metadata.termination_reason),
    };
  }
  if (payload.type === "call_initiation_failure") {
    if (!conversationId) return { type: "ignored", reason: "missing_conversation_id" };
    return {
      type: "initiation_failure",
      conversationId,
      callRef: callRefOf(data),
      failureReason: text(data.failure_reason) ?? "unknown",
    };
  }
  return { type: "ignored", reason: "unsupported_type" };
}
