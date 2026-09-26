import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { slugify } from "../../../../_lib/slug";
import { z } from "zod";
export const maxDuration = 10;
/** `priceCents` minor unit (ADR-0011); UI major birimi ×100 ile çevirir. */
const ServiceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().min(2).max(100).regex(/^[a-z0-9-]+$/, "Slug yalnızca küçük harf, rakam ve tire içerir.").optional(),
  category: z.enum(["MEDICAL", "DENTAL", "WELLNESS", "SURGICAL", "DIAGNOSTIC", "PSYCHIATRIC", "OTHER"]),
  description: z.string().max(4000).optional().nullable(),
  durationDays: z.number().int().min(1).max(365).optional().nullable(),
  priceCents: z.number().int().positive().optional().nullable(),
  currency: z.string().trim().length(3).transform((v) => v.toUpperCase()).optional(),
  recoveryRate: z.number().min(0).max(1).optional().default(0),
  packageIncludes: z.array(z.string().min(1).max(200)).max(50).optional().default([]),
  showStartingPrice: z.boolean().optional().default(true),
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
        select: {
          id: true, name: true, slug: true, category: true, description: true, durationDays: true,
          priceCents: true, currency: true, recoveryRate: true, packageIncludes: true,
          showStartingPrice: true, status: true, createdAt: true,
        },
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
    const slug = input.slug ?? slugify(input.name);
    if (slug.length < 2) throw new HttpError(400, "Hizmet adından slug türetilemedi; slug alanını doldurun.");
    const service = await prisma.$transaction(async (tx) => {
      const created = await tx.service.create({
        data: {
          clinicId,
          name: input.name,
          slug,
          category: input.category,
          description: input.description ?? null,
          durationDays: input.durationDays ?? null,
          priceCents: input.priceCents ?? null,
          ...(input.currency ? { currency: input.currency } : {}),
          recoveryRate: input.recoveryRate,
          packageIncludes: input.packageIncludes,
          showStartingPrice: input.showStartingPrice,
        },
      });
      await logAudit(
        {
          actor,
          action: "SERVICE_CREATED",
          entityType: "SERVICE",
          entityId: created.id,
          after: {
            clinicId,
            name: created.name,
            slug: created.slug,
            category: created.category,
            priceCents: created.priceCents,
            currency: created.currency,
            showStartingPrice: created.showStartingPrice,
          },
        },
        tx,
      );
      return created;
    });
    return { service };
  });
}
