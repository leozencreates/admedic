import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { z } from "zod";
export const maxDuration = 10;
const ServiceSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(2).max(100),
  category: z.enum(["MEDICAL", "DENTAL", "WELLNESS", "SURGICAL", "DIAGNOSTIC", "PSYCHIATRIC", "OTHER"]),
  description: z.string().optional().nullable(),
  durationDays: z.number().int().min(1).max(365).optional().nullable(),
  priceCents: z.number().int().positive().optional().nullable(),
  recoveryRate: z.number().min(0).max(1).optional().default(0),
}).strict();
export async function GET(request: Request, { params }: { params: Promise<{ clinicId: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    const { clinicId } = await params;
    const clinic = await prisma.clinicProfile.findFirst({
      where: { id: clinicId, workspaceId: actor.workspaceId },
    });
    if (!clinic) throw new HttpError(404, "Klinik bulunamadı.");
    return {
      services: await prisma.service.findMany({
        where: { clinicId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, slug: true, category: true, priceCents: true, status: true, createdAt: true },
      }),
    };
  });
}
export async function POST(request: Request, { params }: { params: Promise<{ clinicId: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { clinicId } = await params;
    const clinic = await prisma.clinicProfile.findFirst({
      where: { id: clinicId, workspaceId: actor.workspaceId },
    });
    if (!clinic) throw new HttpError(404, "Klinik bulunamadı.");
    const input = await body(request, ServiceSchema);
    const service = await prisma.service.create({
      data: {
        clinicId,
        name: input.name,
        slug: input.slug,
        category: input.category,
        description: input.description ?? null,
        durationDays: input.durationDays ?? null,
        priceCents: input.priceCents ?? null,
        recoveryRate: input.recoveryRate,
      },
    });
    return { service };
  });
}
