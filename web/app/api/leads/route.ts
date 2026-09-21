import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { body, respond, sameOrigin } from "../../_lib/http";
import { z } from "zod";
export const maxDuration = 10;
const LeadSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().optional().nullable(),
  phone: z.string().min(7).max(20).optional().nullable(),
  country: z.string().optional().nullable(),
  language: z.string().optional().default("tr"),
  channel: z.string().optional().default("LEAD_AD"),
  campaignId: z.string().optional().nullable(),
  adSetId: z.string().optional().nullable(),
  adId: z.string().optional().nullable(),
  metadata: z.record(z.any()).optional(),
  consentGiven: z.boolean().default(false),
}).strict();
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    return {
      leads: await prisma.lead.findMany({
        where: { workspaceId: actor.workspaceId },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true,
          country: true, language: true, channel: true, status: true,
          createdAt: true, updatedAt: true, metadata: true,
        },
      }),
    };
  });
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, LeadSchema);
    const existing = await prisma.lead.findFirst({
      where: {
        organizationId: actor.orgId,
        OR: [
          { phone: input.phone },
          { email: input.email },
        ],
      },
    });
    if (existing) {
      await prisma.lead.update({
        where: { id: existing.id },
        data: { duplicateOf: existing.id },
      });
      throw new HttpError(409, "Bu kişi zaten kayıtlı. Tekrar edilen lead işaretlendi.");
    }
    const lead = await prisma.lead.create({
      data: {
        workspaceId: actor.workspaceId,
        organizationId: actor.orgId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        country: input.country ?? null,
        language: input.language,
        channel: input.channel,
        campaignId: input.campaignId ?? null,
        adSetId: input.adSetId ?? null,
        adId: input.adId ?? null,
        status: "NEW",
        metadata: input.metadata ?? {},
      },
    });
    if (input.consentGiven) {
      await prisma.consentRecord.create({
        data: {
          leadId: lead.id,
          workspaceId: actor.workspaceId,
          type: "MARKETING",
          status: "GRANTED",
          consentText: "Pazarlama iletişimleri için veri işleme onayı.",
          acceptedAt: new Date(),
          ip: null,
          userAgent: null,
        },
      });
    }
    return { lead };
  });
}
import { HttpError } from "../../_lib/http";
