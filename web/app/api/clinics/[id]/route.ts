import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { z } from "zod";
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
        updatedAt: new Date(),
      },
    });
    return { clinic: updated };
  });
}
