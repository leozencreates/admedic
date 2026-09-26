import { prisma, type Prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { z } from "zod";
import { logAudit } from "../../../_lib/audit";
export const maxDuration = 10;
const UpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  category: z.enum(["MEDICAL", "DENTAL", "WELLNESS", "SURGICAL", "DIAGNOSTIC", "PSYCHIATRIC", "OTHER"]).optional(),
  city: z.string().max(120).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  email: z.string().email().optional().nullable(),
  website: z.string().url().optional().nullable(),
  description: z.string().max(4000).optional().nullable(),
  languages: z.array(z.enum(["TR", "EN", "DE", "RU", "AR", "FR", "NL", "PL"])).optional(),
  targetMarket: z.enum(["TURKEY", "GERMANY", "UK", "NETHERLANDS", "USA", "GULF", "OTHER"]).optional(),
  licenseNumber: z.string().max(100).optional().nullable(),
  accreditations: z.array(z.string().min(1).max(100)).optional(),
  brandLogo: z.string().url().optional().nullable(),
  brandColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
  brandTone: z.string().max(2000).optional().nullable(),
  brandBannedPhrases: z.array(z.string().min(2).max(200)).optional(),
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]).optional(),
}).strict();
type UpdateInput = z.infer<typeof UpdateSchema>;
const UPDATABLE_FIELDS = [
  "name", "category", "city", "address", "phone", "email", "website", "description", "languages",
  "targetMarket", "licenseNumber", "accreditations", "brandLogo", "brandColors", "brandTone",
  "brandBannedPhrases", "status",
] as const satisfies readonly (keyof UpdateInput)[];

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const clinic = await prisma.clinicProfile.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      include: { services: { select: { id: true, name: true, category: true, status: true } } },
    });
    if (!clinic) throw new HttpError(404, "Klinik bulunamadı.");
    return { clinic };
  });
}
/**
 * Kısmi güncelleme: yalnızca gönderilen alanlar değişir; `null` ile temizleme
 * mümkündür (`?? clinic.x` yerine `!== undefined`). Audit, değişen tüm alanların
 * before/after farkını içerir.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const input = await body(request, UpdateSchema);
    const clinic = await prisma.clinicProfile.findFirst({
      where: { id, workspaceId: actor.workspaceId },
    });
    if (!clinic) throw new HttpError(404, "Klinik bulunamadı.");
    const data: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const field of UPDATABLE_FIELDS) {
      const value = input[field];
      if (value === undefined) continue;
      if (sameValue(value, clinic[field])) continue;
      data[field] = value;
      before[field] = clinic[field];
      after[field] = value;
    }
    if (Object.keys(data).length === 0) return { clinic, changed: [] };
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.clinicProfile.update({
        where: { id },
        data: data as Prisma.ClinicProfileUncheckedUpdateInput,
      });
      await logAudit(
        {
          actor,
          action: "CLINIC_UPDATED",
          entityType: "CLINIC",
          entityId: id,
          before: before as Prisma.InputJsonValue,
          after: after as Prisma.InputJsonValue,
        },
        tx,
      );
      return row;
    });
    return { clinic: updated, changed: Object.keys(data) };
  });
}
