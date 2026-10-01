import type { Role } from "@admedic/database";
import { z } from "zod";

/** Kısa, serbest metin taşıyamayan kimlikler (kayıt ref'i, konuşma kimliği). */
const Ref = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/**
 * Sesli asistan olay gövdesi (ADR-0028). Şema bilerek dar ve `strict`: bilinmeyen alan (ör. `transcript`, `text`,
 * `args`) 400 ile reddedilir, böylece konuşma metni ya da hasta verisi denetim kaydına giremez. R4 işlemleri sesle hiç
 * çalışmadığı için risk listesinde yoktur.
 */
export const AssistantEventSchema = z
  .object({
    type: z.enum(["tool_call", "consent_given"]),
    tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
    risk: z.enum(["R0", "R1", "R2", "R3"]).optional(),
    entityRef: Ref.optional(),
    outcome: z.enum(["ok", "denied", "error", "cancelled"]).optional(),
    conversationId: Ref.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.type === "tool_call" && (!event.tool || !event.risk || !event.outcome))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "tool_call için tool, risk ve outcome gerekir." });
    if (event.type === "consent_given" && (event.tool || event.risk || event.entityRef || event.outcome))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "consent_given yalnızca conversationId taşır." });
  });

export type AssistantEvent = z.infer<typeof AssistantEventSchema>;

export type AssistantRisk = "R0" | "R1" | "R2" | "R3";

/** `auth.ts` EDIT_ROLES ile aynı; modül saf kalsın (istemci de kullanabilsin) diye sunucu modülü içe aktarılmaz. */
const EDIT: readonly Role[] = ["OWNER", "ADMIN", "MEDIA_BUYER"];

/**
 * Bir rolün sesle tetikleyebileceği en yüksek risk (ADR-0028 §2–3, denetim kaydı için alt sınır). Araç kaydı
 * (`registry.ts`) Faz 2'de gelene kadar araç adı doğrulanamaz; en azından rolün hiç çalıştıramayacağı seviyede bir
 * kayıt yazılmaz. R0 herkese açık; R1 izleyiciye kapalı (izleyici yalnızca gezinme ve okuma); R2 düzenleme rolleri;
 * R3 harcama yetkisi ister.
 */
export function riskAllowedFor(risk: AssistantRisk, role: Role, canApproveSpend: boolean): boolean {
  switch (risk) {
    case "R0":
      return true;
    case "R1":
      return role !== "VIEWER";
    case "R2":
      return EDIT.includes(role);
    case "R3":
      return EDIT.includes(role) && canApproveSpend;
  }
}
