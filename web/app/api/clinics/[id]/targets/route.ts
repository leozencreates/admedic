import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { z } from "zod";

export const maxDuration = 15;

const TargetSchema = z
  .object({
    country: z.string().min(2).max(3),
    region: z.string().optional(),
    language: z.enum(["TR", "EN", "DE", "RU", "AR", "FR", "NL", "PL"]).optional(),
    currency: z.string().optional(),
    demand: z.number().optional(),
  })
  .strict();

export async function GET(request: Request) {
  return respond(async () => {
    const actor = await requireActor();
    const clinic = await prisma.clinicProfile.findFirst({
      where: { workspaceId: actor.workspaceId },
    });
    if (!clinic) throw new HttpError(404, "Klinik bulunamadı.");
    const targets = await prisma.marketTarget.findMany({
      where: { clinicId: clinic.id },
      orderBy: { country: "asc" },
    });
    return { targets };
  });
}

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN", ...EDIT_ROLES]);
    const input = await body(request, TargetSchema);
    return prisma.$transaction(async (tx) => {
      const clinic = await tx.clinicProfile.findFirst({
        where: { workspaceId: actor.workspaceId },
      });
      if (!clinic) throw new HttpError(404, "Klinik bulunamadı.");
      const existing = await tx.marketTarget.findUnique({
        where: { clinicId_country: { clinicId: clinic.id, country: input.country } },
      });
      if (existing) {
        const updated = await tx.marketTarget.update({
          where: { id: existing.id },
          data: {
            region: input.region ?? existing.region,
            language: input.language ?? existing.language,
            currency: input.currency ?? existing.currency,
            demand: input.demand ?? existing.demand,
          },
        });
        await logAudit({ actor, action: "MARKET_TARGET_UPDATED", entityType: "MARKET_TARGET", entityId: updated.id, before: { country: existing.country }, after: { country: updated.country, language: updated.language } }, tx);
        return { target: updated, created: false };
      }
      const target = await tx.marketTarget.create({
        data: {
          clinicId: clinic.id,
          country: input.country,
          region: input.region ?? null,
          language: input.language ?? "TR",
          currency: input.currency ?? "EUR",
          demand: input.demand ?? 0,
        },
      });
      await logAudit({ actor, action: "MARKET_TARGET_CREATED", entityType: "MARKET_TARGET", entityId: target.id, after: { country: target.country, language: target.language } }, tx);
      return { target, created: true };
    });
  });
}