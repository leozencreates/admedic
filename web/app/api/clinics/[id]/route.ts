import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { z } from "zod";
import { logAudit } from "../../../_lib/audit";
export const maxDuration = 10;
const UpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  category: z.enum(["MEDICAL", "DENTAL", "WELLNESS", "SURGICAL", "DIAGNOSTIC", "PSYCHIATRIC", "OTHER"]).optional(),
  address: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  website: z.string().url().optional().nullable(),
  description: z.string().optional().nullable(),
  languages: z.array(z.enum(["TR", "EN", "DE", "RU", "AR"])).optional(),
  targetMarket: z.enum(["TURKEY", "GERMANY", "UK", "NETHERLANDS", "USA", "GULF", "OTHER"]).optional(),
  licenseNumber: z.string().optional().nullable(),
  accreditations: z.array(z.string().min(1).max(100)).optional(),
  brandLogo: z.string().url().optional().nullable(),
  brandColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
  brandTone: z.string().max(2000).optional().nullable(),
  brandBannedPhrases: z.array(z.string().min(2).max(200)).optional(),
}).strict();
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
    const updated = await prisma.clinicProfile.update({
      where: { id },
      data: {
        name: input.name ?? clinic.name,
        category: input.category ?? clinic.category,
        address: input.address ?? clinic.address,
        phone: input.phone ?? clinic.phone,
        email: input.email ?? clinic.email,
        website: input.website ?? clinic.website,
        description: input.description ?? clinic.description,
        languages: input.languages ?? clinic.languages,
        targetMarket: input.targetMarket ?? clinic.targetMarket,
        licenseNumber: input.licenseNumber ?? clinic.licenseNumber,
        accreditations: input.accreditations ?? clinic.accreditations,
        brandLogo: input.brandLogo ?? clinic.brandLogo,
        brandColors: input.brandColors ?? clinic.brandColors,
        brandTone: input.brandTone ?? clinic.brandTone,
        brandBannedPhrases: input.brandBannedPhrases ?? clinic.brandBannedPhrases,
        updatedAt: new Date(),
      },
    });
    await logAudit({
      actor,
      action: "CLINIC_UPDATED",
      entityType: "CLINIC",
      entityId: id,
      before: { name: clinic.name },
      after: { name: updated.name, category: updated.category },
    });
    return { clinic: updated };
  });
}
