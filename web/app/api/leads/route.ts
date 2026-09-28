import { prisma } from "@admedic/database";
import { requireActor, requireRole, CARE_ROLES, LEAD_READ_ROLES } from "../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../_lib/http";
import { z } from "zod";
import { encrypt } from "../../_lib/encrypt";
import { leadLookupHash } from "../../_lib/lead-hash";
import { logAudit } from "../../_lib/audit";
import { presentContact, sanitizeMetadata } from "../../_lib/lead-view";
import { inboxStates, needsReplySummary } from "../../_lib/inbox";
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
/** Listenin en yeni lead sayısı; yanıt bekleyen daha eski lead'ler buna eklenir. */
const LIST_LIMIT = 100;

export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    requireRole(actor, LEAD_READ_ROLES);
    const select = {
      id: true, firstName: true, lastName: true, email: true, phone: true,
      country: true, language: true, channel: true, status: true,
      interestedService: true, campaignId: true, adSetId: true, adId: true,
      createdAt: true, updatedAt: true, metadata: true, consentGiven: true,
    } as const;
    const [recent, waiting] = await Promise.all([
      prisma.lead.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "desc" }, take: LIST_LIMIT, select }),
      needsReplySummary(actor),
    ]);
    // Rozetle aynı küme: en yeni LIST_LIMIT lead'e ek olarak, daha eski ama hâlâ yanıt bekleyen lead'ler de listelenir
    // (en uzun bekleyen "Yanıt bekleyen" sekmesinden düşmesin).
    const seen = new Set(recent.map((r) => r.id));
    const missing = waiting.leadIds.filter((id) => !seen.has(id));
    const older = missing.length
      ? await prisma.lead.findMany({ where: { workspaceId: actor.workspaceId, id: { in: missing } }, orderBy: { createdAt: "desc" }, select })
      : [];
    const rows = [...recent, ...older];
    // Gelen kutusu (ADR-0019): konuşma durumu, son mesaj (önizleme yalnızca bakım rollerine) ve "yanıt bekliyor".
    const inbox = await inboxStates(actor, rows);
    return {
      // lookupHash select'te yok; e-posta/telefon role göre açık ya da maskeli döner.
      leads: rows.map((r) => ({
        ...r,
        ...presentContact(actor.role, { email: r.email, phone: r.phone }),
        metadata: sanitizeMetadata(r.metadata),
        inbox: inbox.get(r.id) ?? null,
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
      if (existing) throw new HttpError(409, "Bu kişi zaten kayıtlı. Lead'ler sayfasında mevcut kaydı arayın.");
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
          source: "PANEL", evidence: { recordedBy: actor.userId },
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
