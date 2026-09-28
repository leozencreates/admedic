import type { AlertType, Prisma } from "@admedic/database";
import { ESCALATION_ROLES, type Actor } from "./auth";
import { HANDOFF_ALERT_TYPE } from "./lead-assistant";

/**
 * Uyarıların rol kapsamı (ADR-0017 §4) — zil, rozet, Uyarılar sayfası ve `/api/alerts` aynı kuralı kullanır:
 * - İzleyici uyarı görmez (`null`).
 * - Hasta koordinatörü yalnızca konuşma devri uyarılarını görür.
 * - Diğer roller çalışma alanının tüm uyarılarını görür.
 */
export function alertScope(actor: Actor): Prisma.AlertWhereInput | null {
  if (actor.role === "VIEWER") return null;
  const base: Prisma.AlertWhereInput = { workspaceId: actor.workspaceId };
  if (actor.role === "PATIENT_COORDINATOR") return { ...base, type: HANDOFF_ALERT_TYPE as AlertType };
  return base;
}

/**
 * Uyarıyı "Görüldü/Çözüldü" yapabilir mi? Devir uyarısı yalnızca hastayla yazışabilen rollerce kapatılır
 * (reklam uzmanı devralmadan koordinatörün zilinden silemesin); diğer uyarılar hasta koordinatörü dışındaki
 * düzenleme rollerince.
 */
export function canManageAlert(actor: Actor, alertType: string): boolean {
  if (alertType === HANDOFF_ALERT_TYPE) return ESCALATION_ROLES.includes(actor.role);
  return actor.role === "OWNER" || actor.role === "ADMIN" || actor.role === "MEDIA_BUYER";
}
