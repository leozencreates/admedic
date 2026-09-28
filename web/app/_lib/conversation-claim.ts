import { prisma, AlertType, type MessageChannel, type Prisma } from "@admedic/database";
import type { Actor } from "./auth";
import { logAudit } from "./audit";

/**
 * Konuşma devri (spec 3.8 · ADR-0016 Faz 1 "devir gerçeği"). ESCALATED iki durumdur:
 * - `escalatedTo` boş: karşılama asistanı konuşmayı devretti, henüz kimse devralmadı (eylem bekleniyor);
 * - `escalatedTo` dolu: bir ekip üyesi konuşmayı devraldı; asistan susar.
 * Sahipsiz devri devralmak (düğmeyle ya da ilk yanıtla) sahibi yazar, panelde sistem notu bırakır,
 * denetime yazılır ve o konuşma için açık "asistan devretti" uyarılarını çözer.
 */

type Db = Prisma.TransactionClient;

/** Görünen ad: ad soyad, yoksa e-postanın yerel kısmı; ikisi de yoksa null. */
export function displayNameOf(user: { name: string | null; email: string } | null | undefined): string | null {
  const name = user?.name?.trim();
  if (name) return name;
  const local = user?.email?.split("@")[0]?.trim();
  return local || null;
}

/** Sistem notlarında kullanıcı kimliği yerine görünen ad yazılır. */
export async function userDisplayName(userId: string, db: Db = prisma): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  return displayNameOf(user) ?? "ekip üyesi";
}

/**
 * Kimlik → görünen ad; yalnızca organizasyonun üyeleri (eski ya da yabancı kimliğin adı sızmaz).
 * Bulunamayan kimlik haritada yer almaz.
 */
export async function memberDisplayNames(
  orgId: string,
  userIds: Array<string | null | undefined>,
  db: Db = prisma,
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids }, memberships: { some: { orgId } } },
    select: { id: true, name: true, email: true },
  });
  const out = new Map<string, string>();
  for (const user of users) {
    const name = displayNameOf(user);
    if (name) out.set(user.id, name);
  }
  return out;
}

/**
 * Konuşmaya bağlı açık (OPEN/ACKED) "asistan devretti" uyarılarını çözer (uyarılar sayfasındaki
 * "Çözüldü" ile aynı alanlar). Çözülen uyarı kimliklerini döner.
 */
export async function resolveHandoffAlerts(
  db: Db,
  workspaceId: string,
  conversationId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const where = {
    workspaceId,
    type: AlertType.CONVERSATION_ESCALATED,
    entityType: "CONVERSATION",
    entityId: conversationId,
    status: { in: ["OPEN", "ACKED"] as ("OPEN" | "ACKED")[] },
  };
  const open = await db.alert.findMany({ where, select: { id: true } });
  if (!open.length) return [];
  await db.alert.updateMany({
    where: { ...where, id: { in: open.map((a) => a.id) } },
    data: { status: "RESOLVED", read: true, resolvedAt: now },
  });
  return open.map((a) => a.id);
}

/**
 * Asistanın devrettiği (ESCALATED, sahipsiz) konuşmayı `actor` adına devralır. Koşullu güncelleme:
 * konuşma bu arada devralınmış ya da kapanmışsa hiçbir şey yazılmaz ve false döner (eşzamanlı iki
 * devralmadan yalnızca biri kazanır). `escalatedAt` (asistanın devir anı) korunur.
 */
export async function claimHandoff(
  db: Db,
  input: {
    actor: Actor;
    conversation: { id: string; workspaceId: string; channel: MessageChannel };
    displayName: string;
    via: "button" | "message";
    note?: string;
  },
): Promise<boolean> {
  const { actor, conversation } = input;
  const updated = await db.conversation.updateMany({
    where: { id: conversation.id, status: "ESCALATED", escalatedTo: null },
    data: { escalatedTo: actor.userId },
  });
  if (updated.count === 0) return false;
  // Sistem notu: dış kanala gönderilmez, yalnızca panelde görünür.
  await db.message.create({
    data: {
      conversationId: conversation.id,
      direction: "OUTGOING",
      channel: conversation.channel,
      content: `Konuşma ${input.displayName} tarafından devralındı.${input.note ? ` Not: ${input.note}` : ""}`,
      sender: "system",
      metadata: { type: "CLAIM" },
    },
  });
  const resolvedAlertIds = await resolveHandoffAlerts(db, conversation.workspaceId, conversation.id);
  await logAudit(
    {
      actor,
      action: "CONVERSATION_CLAIMED",
      entityType: "CONVERSATION",
      entityId: conversation.id,
      before: { status: "ESCALATED", escalatedTo: null },
      after: { status: "ESCALATED", escalatedTo: actor.userId, via: input.via, resolvedAlertIds },
    },
    db,
  );
  return true;
}
