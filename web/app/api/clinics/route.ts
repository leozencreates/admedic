import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../_lib/http";
import { z } from "zod";
import { logAudit } from "../../_lib/audit";
import { slugify } from "../../_lib/slug";
export const maxDuration = 10;
const ClinicSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Verilmezse addan türetilir (küçük harf, Türkçe karakterler sadeleştirilir). */
  slug: z.string().trim().min(2).max(100).regex(/^[a-z0-9-]+$/, "Slug yalnızca küçük harf, rakam ve tire içerir.").optional(),
  category: z.enum(["MEDICAL", "DENTAL", "WELLNESS", "SURGICAL", "DIAGNOSTIC", "PSYCHIATRIC", "OTHER"]).optional().default("MEDICAL"),
  city: z.string().max(120).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  email: z.string().email().optional().nullable(),
  website: z.string().url().optional().nullable(),
  description: z.string().max(4000).optional().nullable(),
  languages: z.array(z.enum(["TR", "EN", "DE", "RU", "AR", "FR", "NL", "PL"])).optional().default(["TR"]),
  targetMarket: z.enum(["TURKEY", "GERMANY", "UK", "NETHERLANDS", "USA", "GULF", "OTHER"]).optional().default("TURKEY"),
  licenseNumber: z.string().max(100).optional().nullable(),
  accreditations: z.array(z.string().min(1).max(100)).optional().default([]),
  brandLogo: z.string().url().optional().nullable(),
  brandColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional().default([]),
  brandTone: z.string().max(2000).optional().nullable(),
  brandBannedPhrases: z.array(z.string().min(2).max(200)).optional().default([]),
}).strict();

export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    return {
      clinics: await prisma.clinicProfile.findMany({
        where: { workspaceId: actor.workspaceId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, slug: true, category: true, status: true, createdAt: true, updatedAt: true, brandLogo: true },
      }),
    };
  });
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const input = await body(request, ClinicSchema);
    const slug = input.slug ?? slugify(input.name);
    if (slug.length < 2) throw new HttpError(400, "Klinik adından slug türetilemedi; slug alanını doldurun.");
    const clinic = await prisma.$transaction(async (tx) => {
      const created = await tx.clinicProfile.create({
        data: {
          workspaceId: actor.workspaceId,
          name: input.name,
          slug,
          category: input.category,
          city: input.city ?? null,
          address: input.address ?? null,
          phone: input.phone ?? null,
          email: input.email ?? null,
          website: input.website ?? null,
          description: input.description ?? null,
          languages: input.languages,
          targetMarket: input.targetMarket,
          licenseNumber: input.licenseNumber ?? null,
          accreditations: input.accreditations,
          brandLogo: input.brandLogo ?? null,
          brandColors: input.brandColors,
          brandTone: input.brandTone ?? null,
          brandBannedPhrases: input.brandBannedPhrases,
        },
      });
      await logAudit(
        {
          actor,
          action: "CLINIC_CREATED",
          entityType: "CLINIC",
          entityId: created.id,
          after: { name: created.name, slug: created.slug, category: created.category, targetMarket: created.targetMarket, languages: created.languages },
        },
        tx,
      );
      return created;
    });
    return { clinic };
  });
}
