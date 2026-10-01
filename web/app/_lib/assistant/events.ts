import type { Role } from "@admedic/database";
import { z } from "zod";

/** Kısa, serbest metin taşıyamayan kimlikler (kayıt ref'i, konuşma kimliği). */
const Ref = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/**
 * Sesli asistan olay gövdesi (ADR-0028). Şema bilerek dar ve `strict`: bilinmeyen alan (ör. `transcript`, `text`,
 * `args`) 400 ile reddedilir, böylece konuşma metni ya da hasta verisi denetim kaydına giremez. R4 işlemleri sesle hiç
 * çalışmadığı için risk listesinde yoktur.
 * `session_ended` (Faz 5): oturum süresi (tam sayı, sn) aylık dakika bütçesi için ve sunucunun verdiği oturum kimliği
 * (`sessionRef`, `/api/assistant/session` yanıtı). Sunucu oturumu kimlikle bulur, bir kez kaydeder ve süreyi kırpar
 * (`assistant-usage.ts` `recordVoiceSessionEnd`). Bir günden uzun değer şemada reddedilir.
 */
export const AssistantEventSchema = z
  .object({
    type: z.enum(["tool_call", "consent_given", "session_ended"]),
    tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
    risk: z.enum(["R0", "R1", "R2", "R3"]).optional(),
    entityRef: Ref.optional(),
    outcome: z.enum(["ok", "denied", "error", "cancelled"]).optional(),
    conversationId: Ref.optional(),
    durationSeconds: z.number().int().min(0).max(86_400).optional(),
    sessionRef: Ref.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.type === "tool_call" && (!event.tool || !event.risk || !event.outcome))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "tool_call için tool, risk ve outcome gerekir." });
    if (event.type !== "session_ended" && event.durationSeconds !== undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "durationSeconds yalnızca session_ended içindir." });
    if (event.type !== "session_ended" && event.sessionRef !== undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sessionRef yalnızca session_ended içindir." });
    if (event.type === "consent_given" && (event.tool || event.risk || event.entityRef || event.outcome))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "consent_given yalnızca conversationId taşır." });
    if (event.type === "session_ended") {
      if (event.durationSeconds === undefined || event.sessionRef === undefined)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "session_ended için durationSeconds ve sessionRef gerekir." });
      if (event.tool || event.risk || event.entityRef || event.outcome)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "session_ended yalnızca sessionRef, durationSeconds ve conversationId taşır.",
        });
    }
  });

export type AssistantEvent = z.infer<typeof AssistantEventSchema>;

export type AssistantRisk = "R0" | "R1" | "R2" | "R3";

/** `auth.ts` EDIT_ROLES ile aynı; modül saf kalsın (istemci de kullanabilsin) diye sunucu modülü içe aktarılmaz. */
const EDIT: readonly Role[] = ["OWNER", "ADMIN", "MEDIA_BUYER"];
/** `auth.ts` CARE_ROLES ile aynı: R2'de lead durumu (Meta CAPI dönüşümü tetikler) hasta koordinatörüne de açıktır. */
const CARE: readonly Role[] = [...EDIT, "PATIENT_COORDINATOR"];

/**
 * Bir rolün sesle tetikleyebileceği en yüksek risk (ADR-0028 §2–3, denetim kaydı için alt sınır). Olay ucu ayrıca
 * araç adını kayıtta arar ve bildirilen riskin kayıttakiyle aynı olmasını ister (`registry.ts` `findTool`; bu modül
 * kaydı içe aktarmaz, döngü olmasın). R0 herkese açık; R1 izleyiciye kapalı (izleyici yalnızca gezinme ve okuma); R2 düzenleme rolleri
 * ve hasta koordinatörü (Faz 4; koordinatör yalnızca `update_lead_status`: aracın kendi rol listesi kampanya araçlarını
 * düzenleme rolleriyle sınırlar, `registry.ts` `toolAllowedFor`); R3 düzenleme rolü + harcama yetkisi ister.
 */
export function riskAllowedFor(risk: AssistantRisk, role: Role, canApproveSpend: boolean): boolean {
  switch (risk) {
    case "R0":
      return true;
    case "R1":
      return role !== "VIEWER";
    case "R2":
      return CARE.includes(role);
    case "R3":
      return EDIT.includes(role) && canApproveSpend;
  }
}
