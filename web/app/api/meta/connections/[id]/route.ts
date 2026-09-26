import { prisma } from "@admedic/database";
import { z } from "zod";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { deliverDisconnectWebhook } from "../../../../_lib/disconnect-webhook";

export const maxDuration = 15;

/** Meta kimlikleri: rakam/harf/alt çizgi; boş string → null (temizleme). */
const metaId = z
  .string()
  .trim()
  .max(64)
  .regex(/^[A-Za-z0-9_.-]*$/, "Yalnızca harf, rakam, nokta, tire ve alt çizgi.")
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();

/**
 * Meta App Review tamamlanana kadar Pixel/Dataset, WhatsApp ve Sayfa/Instagram
 * kimlikleri OWNER/ADMIN tarafından elle eşlenebilir (webhook yönlendirmesi ve
 * CAPI hedefi bu alanlardan okunur).
 */
const PatchSchema = z
  .object({
    pixelId: metaId,
    whatsappPhoneNumberId: metaId,
    whatsappBusinessId: metaId,
    pageId: metaId,
    instaId: metaId,
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Güncellenecek alan yok." });

const EDITABLE_FIELDS = ["pixelId", "whatsappPhoneNumberId", "whatsappBusinessId", "pageId", "instaId", "name"] as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    const input = await body(request, PatchSchema);
    const conn = await prisma.metaConnection.findUnique({ where: { id } });
    if (!conn || conn.orgId !== actor.orgId)
      throw new HttpError(404, "Meta bağlantısı bulunamadı.");

    const data: Record<string, string | null> = {};
    const before: Record<string, string | null> = {};
    const after: Record<string, string | null> = {};
    for (const field of EDITABLE_FIELDS) {
      const value = input[field];
      if (value === undefined) continue;
      if (conn[field] === value) continue;
      data[field] = value;
      before[field] = conn[field];
      after[field] = value;
    }
    if (Object.keys(data).length === 0)
      return { connection: publicConnection(conn), changed: [] };

    // Webhook yönlendirme kimlikleri organizasyonlar arasında benzersiz olmalı: başka bir
    // organizasyonun aktif bağlantısında kayıtlı bir kimlik (sayfa, Instagram, WhatsApp
    // numara/işletme, pixel) buraya eşlenemez — aksi halde o tenant'ın lead'leri buraya akar.
    const ROUTING_FIELDS = ["pageId", "instaId", "whatsappPhoneNumberId", "whatsappBusinessId", "pixelId"] as const;
    for (const field of ROUTING_FIELDS) {
      const value = data[field];
      if (!value) continue;
      const clash = await prisma.metaConnection.findFirst({
        where: { [field]: value, orgId: { not: actor.orgId }, status: { in: ["CONNECTED", "DEGRADED"] } },
        select: { id: true },
      });
      if (clash)
        throw new HttpError(409, "Bu kimlik başka bir organizasyonun bağlantısında kayıtlı; eşleme reddedildi.");
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.metaConnection.update({ where: { id: conn.id }, data });
      await logAudit(
        {
          actor,
          action: "META_CONNECTION_UPDATED",
          entityType: "META_CONNECTION",
          entityId: conn.id,
          before,
          after,
        },
        tx,
      );
      return row;
    });
    return { connection: publicConnection(updated), changed: Object.keys(data) };
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    const conn = await prisma.metaConnection.findUnique({ where: { id } });
    if (!conn || conn.orgId !== actor.orgId)
      throw new HttpError(404, "Meta bağlantısı bulunamadı.");

    const adAccounts = await prisma.adAccount.findMany({
      where: { connectionId: conn.id },
      select: { id: true },
    });
    const label = conn.name ?? conn.metaAccountId ?? conn.id;

    await prisma.$transaction(async (tx) => {
      await tx.metaConnection.update({
        where: { id: conn.id },
        data: {
          status: "REVOKED",
          tokenCiphertext: null,
          lastError: "Kullanıcı bağlantıyı kesti.",
        },
      });
      await tx.adAccount.updateMany({
        where: { connectionId: conn.id },
        data: { status: "PAUSED" },
      });
      // Scheduler dedup'ı için OPEN uyarı: worker aynı bağlantı için ikinci bir
      // uyarı/webhook üretmez (spec 3.1 "bağlantı kesilince UI'da uyarı").
      const open = await tx.alert.findFirst({
        where: { workspaceId: actor.workspaceId, type: "META_DISCONNECTED", entityId: conn.id, status: "OPEN" },
        select: { id: true },
      });
      if (!open) {
        await tx.alert.create({
          data: {
            workspaceId: actor.workspaceId,
            type: "META_DISCONNECTED",
            severity: "CRITICAL",
            title: `Meta bağlantısı REVOKED: ${label}`,
            message: `${conn.type} bağlantısı (${label}) kullanıcı tarafından kesildi. ${adAccounts.length} reklam hesabı duraklatıldı; kampanya işlemleri durduruldu.`,
            entityType: "META_CONNECTION",
            entityId: conn.id,
          },
        });
      }
      await logAudit(
        {
          actor,
          action: "META_DISCONNECTED",
          entityType: "META_CONNECTION",
          entityId: conn.id,
          before: { status: conn.status },
          after: { status: "REVOKED", adAccounts: adAccounts.length },
        },
        tx,
      );
    });

    await deliverDisconnectWebhook({
      workspaceId: actor.workspaceId,
      connectionId: conn.id,
      adAccountIds: adAccounts.map((a) => a.id),
      connectionType: conn.type,
      status: "REVOKED",
      connectionName: conn.name ?? null,
      metaAccountId: conn.metaAccountId ?? null,
    });

    return {
      connection: {
        id: conn.id,
        status: "REVOKED",
        adAccountsPaused: adAccounts.length,
      },
    };
  });
}

/** Token içermeyen, UI'a dönen bağlantı görünümü. */
function publicConnection(conn: {
  id: string; type: string; status: string; name: string | null; metaAccountId: string | null;
  metaUserId: string | null; scopes: string[]; missingPermissions: string[]; pageId: string | null;
  instaId: string | null; pixelId: string | null; whatsappPhoneNumberId: string | null;
  whatsappBusinessId: string | null; appId: string | null; expiresAt: Date | null; lastError: string | null;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    id: conn.id, type: conn.type, status: conn.status, name: conn.name,
    metaAccountId: conn.metaAccountId, metaUserId: conn.metaUserId, scopes: conn.scopes,
    missingPermissions: conn.missingPermissions, pageId: conn.pageId, instaId: conn.instaId,
    pixelId: conn.pixelId, whatsappPhoneNumberId: conn.whatsappPhoneNumberId,
    whatsappBusinessId: conn.whatsappBusinessId, appId: conn.appId, expiresAt: conn.expiresAt,
    lastError: conn.lastError, createdAt: conn.createdAt, updatedAt: conn.updatedAt,
  };
}
