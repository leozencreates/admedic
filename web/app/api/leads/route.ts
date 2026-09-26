import { prisma } from "@admedic/database";
import { requireActor, requireRole, CARE_ROLES } from "../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../_lib/http";
import { z } from "zod";
import { encrypt } from "../../_lib/encrypt";
import { leadLookupHash } from "../../_lib/lead-hash";
import { logAudit } from "../../_lib/audit";
import { presentContact, sanitizeMetadata } from "../../_lib/lead-view";
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
  interestedService: z.string().optional().nullable(),
  metadata: z.record(z.any()).optional(),
  consentGiven: z.boolean().default(false),
}).strict();
function safeEncrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  return encrypt(value);
}
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const rows = await prisma.lead.findMany({
      where: { workspaceId: actor.workspaceId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true, firstName: true, lastName: true, email: true, phone: true,
        country: true, language: true, channel: true, status: true,
        interestedService: true, campaignId: true, adSetId: true, adId: true,
        createdAt: true, updatedAt: true, metadata: true, consentGiven: true,
      },
    });
    return {
      // lookupHash select'te yok; e-posta/telefon role göre açık ya da maskeli döner.
      leads: rows.map((r) => ({
        ...r,
        ...presentContact(actor.role, { email: r.email, phone: r.phone }),
        metadata: sanitizeMetadata(r.metadata),
      })),
    };
  });
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, CARE_ROLES);
    const input = await body(request, LeadSchema);
    const hash = leadLookupHash({ orgId: actor.orgId, phone: input.phone, email: input.email });
    return prisma.$transaction(async (tx) => {
    if (hash) {
      // void dönen ifade: $queryRaw ile çalışmaz ("Failed to deserialize column of type 'void'").
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.orgId}), hashtext(${hash}))`;
      const existing = await tx.lead.findFirst({
        where: { organizationId: actor.orgId, lookupHash: hash }, select: { id: true },
      });
      if (existing) throw new HttpError(409, "Bu kişi zaten kayıtlı.");
    }
    const lead = await tx.lead.create({
      data: {
        workspaceId: actor.workspaceId,
        organizationId: actor.orgId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: safeEncrypt(input.email),
        phone: safeEncrypt(input.phone),
        country: input.country ?? null,
        language: input.language,
        channel: input.channel,
        campaignId: input.campaignId ?? null,
        adSetId: input.adSetId ?? null,
        adId: input.adId ?? null,
        interestedService: input.interestedService ?? null,
        status: "NEW",
        lookupHash: hash,
        consentGiven: input.consentGiven,
        metadata: input.metadata ?? {},
      },
    });
    if (input.consentGiven) {
      const org = await tx.organization.findUnique({
        where: { id: actor.orgId },
        select: { consentText: true },
      });
      await tx.consentRecord.create({
        data: {
          leadId: lead.id, workspaceId: actor.workspaceId,
          type: "MARKETING", status: "GRANTED",
          consentText:
            org?.consentText ??
            "Pazarlama iletişimleri için veri işleme onayı.",
          acceptedAt: new Date(), ip: null, userAgent: null,
        },
      });
    }
    await logAudit({
      actor,
      action: "LEAD_CREATED",
      entityType: "LEAD",
      entityId: lead.id,
      after: { status: lead.status, channel: input.channel, consentGiven: Boolean(input.consentGiven) },
    }, tx);
    return {
      lead: {
        ...lead,
        ...presentContact(actor.role, { email: lead.email, phone: lead.phone }),
        metadata: sanitizeMetadata(lead.metadata),
        lookupHash: undefined,
      },
    };
    });
  });
}
