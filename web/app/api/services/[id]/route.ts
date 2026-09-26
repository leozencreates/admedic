import { prisma, type Prisma } from "@admedic/database";
import { z } from "zod";
import { requireActor, requireRole, EDIT_ROLES } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { logAudit } from "../../../_lib/audit";

export const maxDuration = 10;

/**
 * Hizmet güncelleme. `priceCents` minor unit (ADR-0011; POST ile aynı sözleşme),
 * `null` ile temizlenebilir. Yalnızca gönderilen alanlar değişir; audit değişen
 * alanların before/after farkını içerir.
 */
const ServicePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    slug: z.string().trim().min(2).max(100).regex(/^[a-z0-9-]+$/).optional(),
    category: z.enum(["MEDICAL", "DENTAL", "WELLNESS", "SURGICAL", "DIAGNOSTIC", "PSYCHIATRIC", "OTHER"]).optional(),
    description: z.string().max(4000).optional().nullable(),
    durationDays: z.number().int().min(1).max(365).optional().nullable(),
    priceCents: z.number().int().positive().optional().nullable(),
    currency: z.string().trim().length(3).transform((v) => v.toUpperCase()).optional(),
    recoveryRate: z.number().min(0).max(1).optional(),
    packageIncludes: z.array(z.string().min(1).max(200)).max(50).optional(),
    showStartingPrice: z.boolean().optional(),
    status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]).optional(),
  })
  .strict();
type ServicePatch = z.infer<typeof ServicePatchSchema>;
const FIELDS = [
  "name", "slug", "category", "description", "durationDays", "priceCents", "currency",
  "recoveryRate", "packageIncludes", "showStartingPrice", "status",
] as const satisfies readonly (keyof ServicePatch)[];

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const input = await body(request, ServicePatchSchema);
    const service = await prisma.service.findFirst({
      where: { id, clinic: { workspaceId: actor.workspaceId } },
    });
    if (!service) throw new HttpError(404, "Hizmet bulunamadı.");
    const data: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const field of FIELDS) {
      const value = input[field];
      if (value === undefined) continue;
      if (sameValue(value, service[field])) continue;
      data[field] = value;
      before[field] = service[field];
      after[field] = value;
    }
    if (Object.keys(data).length === 0) return { service, changed: [] };
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.service.update({
        where: { id },
        data: data as Prisma.ServiceUncheckedUpdateInput,
      });
      await logAudit(
        {
          actor,
          action: "SERVICE_UPDATED",
          entityType: "SERVICE",
          entityId: id,
          before: before as Prisma.InputJsonValue,
          after: after as Prisma.InputJsonValue,
        },
        tx,
      );
      return row;
    });
    return { service: updated, changed: Object.keys(data) };
  });
}

/** Silme = arşivleme (kampanya/kreatif referansları korunur). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const service = await prisma.service.findFirst({
      where: { id, clinic: { workspaceId: actor.workspaceId } },
    });
    if (!service) throw new HttpError(404, "Hizmet bulunamadı.");
    if (service.status === "ARCHIVED") return { service };
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.service.update({
        where: { id },
        data: { status: "ARCHIVED" },
      });
      await logAudit(
        {
          actor,
          action: "SERVICE_ARCHIVED",
          entityType: "SERVICE",
          entityId: id,
          before: { status: service.status },
          after: { status: row.status },
        },
        tx,
      );
      return row;
    });
    return { service: updated };
  });
}
