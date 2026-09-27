import { prisma, anonymizeLead } from "@admedic/database";
import { requireActor, requireRole, CARE_ROLES } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { z } from "zod";
import { encrypt, tryDecryptField } from "../../../_lib/encrypt";
import { logAudit } from "../../../_lib/audit";
import { sendLeadStatusConversion } from "../../../_lib/capi-sync";
import { leadLookupHash } from "../../../_lib/lead-hash";
import { asRecord, mergeLeadMetadata, presentContact, sanitizeMetadata } from "../../../_lib/lead-view";
export const maxDuration = 30;

const LeadStatusEnum = z.enum(["NEW", "CONTACTED", "QUALIFIED", "CONSULTATION_BOOKED", "TRAVEL_PLANNED", "TREATED", "LOST"]);

const UpdateLeadSchema = z.object({
  status: LeadStatusEnum.optional(),
  lostReason: z.string().max(1000).nullable().optional(),
  metadata: z.record(z.any()).optional(),
  consentGiven: z.boolean().optional(),
  email: z.string().email().optional().nullable(),
  phone: z.string().min(7).max(20).optional().nullable(),
}).strict();

const VALID_TRANSITIONS: Record<string, string[]> = {
  NEW: ["CONTACTED", "LOST"],
  CONTACTED: ["QUALIFIED", "LOST"],
  QUALIFIED: ["CONSULTATION_BOOKED", "LOST"],
  CONSULTATION_BOOKED: ["TRAVEL_PLANNED", "LOST"],
  TRAVEL_PLANNED: ["TREATED", "LOST"],
};

const DEFAULT_CONSENT_TEXT = "Pazarlama iletişimleri için veri işleme onayı.";

function getTimestampForStatus(status: string): Record<string, Date> {
  const now = new Date();
  switch (status) {
    case "QUALIFIED": return { qualifiedAt: now };
    case "CONSULTATION_BOOKED": return { consultationBookedAt: now };
    case "TREATED": return { treatedAt: now };
    case "LOST": return { lostAt: now };
    default: return {};
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      include: {
        conversations: {
          include: {
            messages: { orderBy: { createdAt: "desc" }, take: 10 },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı.");
    const consents = await prisma.consentRecord.findMany({
      where: { leadId: lead.id, workspaceId: actor.workspaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true, type: true, status: true, source: true, consentText: true,
        acceptedAt: true, withdrawnAt: true, createdAt: true, evidence: true,
      },
    });
    const meta = asRecord(lead.metadata);
    return { lead: {
      ...lead,
      ...presentContact(actor.role, { email: lead.email, phone: lead.phone }),
      metadata: sanitizeMetadata(lead.metadata),
      lookupHash: undefined,
      // Alanları Meta'dan çekilemeyen Lead Ads lead'i (ADR-0015): panel "yeniden çek" gösterir.
      pendingFetch: meta.pendingFetch === true
        ? { error: typeof meta.fetchError === "string" ? meta.fetchError : null, attempts: typeof meta.fetchAttempts === "number" ? meta.fetchAttempts : 1 }
        : null,
      consents: consents.map((c) => {
        const evidence = asRecord(c.evidence);
        return {
          id: c.id,
          type: c.type,
          status: c.status,
          source: c.source,
          consentText: c.consentText,
          acceptedAt: c.acceptedAt,
          withdrawnAt: c.withdrawnAt,
          createdAt: c.createdAt,
          basis: typeof evidence.basis === "string" ? evidence.basis : null,
          formLanguage: typeof evidence.language === "string" ? evidence.language : null,
        };
      }),
    } };
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    // Hasta koordinatörü lead durumunu güncelleyebilir (spec §2).
    requireRole(actor, CARE_ROLES);
    const { id } = await params;
    const input = await body(request, UpdateLeadSchema);
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: actor.workspaceId },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı.");

    const targetStatus = input.status ?? lead.status;
    if (input.lostReason !== undefined) {
      if (input.lostReason === null || !input.lostReason.trim())
        throw new HttpError(422, "Kayıp nedeni boş olamaz veya silinemez.");
      if (targetStatus !== "LOST")
        throw new HttpError(422, "lostReason yalnızca LOST durumuna geçerken veya LOST iken kabul edilir.");
    }
    if (input.status) {
      const allowed = VALID_TRANSITIONS[lead.status] ?? [];
      if (!allowed.includes(input.status)) {
        throw new HttpError(409, `Geçersiz durum geçişi: ${lead.status} → ${input.status}`);
      }
      if (input.status === "LOST" && !input.lostReason?.trim()) {
        throw new HttpError(422, "LOST geçişi için lostReason zorunludur.");
      }
    }

    const updateData: Record<string, unknown> = {};
    const contactChanged = input.email !== undefined || input.phone !== undefined;
    let nextHash: string | null = lead.lookupHash;
    if (contactChanged) {
      const nextEmail = input.email === undefined ? tryDecryptField(lead.email) : input.email;
      const nextPhone = input.phone === undefined ? tryDecryptField(lead.phone) : input.phone;
      if (input.email !== undefined) updateData.email = input.email ? encrypt(input.email) : null;
      if (input.phone !== undefined) updateData.phone = input.phone ? encrypt(input.phone) : null;
      // Mesajlaşma kaynaklı lead'lerde PSID/IG kimliği öncelikli kalır (webhook eşleşmesi bozulmaz).
      const meta = asRecord(lead.metadata);
      const psid = typeof meta.psid === "string" ? meta.psid : null;
      nextHash = leadLookupHash({
        orgId: actor.orgId,
        phone: nextPhone,
        email: nextEmail,
        psid,
        igId: lead.channel === "INSTAGRAM" ? psid : null,
      });
      updateData.lookupHash = nextHash;
    }
    if (input.status) {
      Object.assign(updateData, { status: input.status }, getTimestampForStatus(input.status));
    }
    if (input.lostReason !== undefined) updateData.lostReason = input.lostReason.trim();
    if (input.metadata !== undefined)
      updateData.metadata = mergeLeadMetadata(asRecord(lead.metadata), input.metadata);

    await prisma.$transaction(async (tx) => {
      if (contactChanged && nextHash && nextHash !== lead.lookupHash) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.orgId}), hashtext(${nextHash}))`;
        const clash = await tx.lead.findFirst({
          where: { organizationId: actor.orgId, lookupHash: nextHash, id: { not: id } },
          select: { id: true },
        });
        if (clash) throw new HttpError(409, "Bu telefon/e-posta aynı organizasyonda başka bir lead'e kayıtlı.");
      }
      if (input.consentGiven === true) {
        const granted = await tx.consentRecord.findFirst({
          where: { leadId: id, workspaceId: actor.workspaceId, type: "MARKETING", status: "GRANTED" },
          select: { id: true },
        });
        if (!granted) {
          const org = await tx.organization.findUnique({
            where: { id: actor.orgId },
            select: { consentText: true },
          });
          await tx.consentRecord.create({
            data: {
              leadId: id,
              workspaceId: actor.workspaceId,
              type: "MARKETING",
              status: "GRANTED",
              consentText: org?.consentText ?? DEFAULT_CONSENT_TEXT,
              acceptedAt: new Date(),
              ip: null,
              userAgent: null,
              // Panelden kaydedilen rıza: kişinin rızasını beyan eden kullanıcı kanıtta tutulur.
              source: "PANEL",
              evidence: { recordedBy: actor.userId },
            },
          });
        }
        updateData.consentGiven = true;
      } else if (input.consentGiven === false) {
        // Rıza geri çekme: açık kayıtlar WITHDRAWN olur, lead artık pazarlama iletişimine kapalıdır.
        await tx.consentRecord.updateMany({
          where: { leadId: id, workspaceId: actor.workspaceId, status: "GRANTED" },
          data: { status: "WITHDRAWN", withdrawnAt: new Date() },
        });
        updateData.consentGiven = false;
      }
      await tx.lead.update({ where: { id }, data: updateData });
      await logAudit({
        actor,
        action: "LEAD_UPDATED",
        entityType: "LEAD",
        entityId: id,
        before: { status: lead.status, consentGiven: lead.consentGiven },
        after: {
          status: input.status ?? lead.status,
          lostReason: input.lostReason ?? undefined,
          consentGiven: input.consentGiven ?? lead.consentGiven,
          contactChanged,
          metadataKeys: input.metadata ? Object.keys(input.metadata) : undefined,
        },
      }, tx);
    });
    // Spec 3.9: CRM durum geçişinden offline dönüşüm (rıza kapısı, Pixel hedefi ve idempotency
    // capi-sync içinde; hata fırlatmaz, sonuç bilgilendirme amaçlı döner).
    const conversion =
      input.status && input.status !== lead.status
        ? await sendLeadStatusConversion(id, input.status, { actor })
        : undefined;
    return { ok: true, ...(conversion ? { conversion } : {}) };
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    // Tek silme yolu: sert silme yerine anonimleştirme (privacy uç noktasıyla aynı davranış).
    await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: { id, workspaceId: actor.workspaceId, organizationId: actor.orgId },
        select: { status: true },
      });
      if (!lead) throw new HttpError(404, "Lead bulunamadı.");
      await logAudit({
        actor,
        action: "LEAD_DELETED",
        entityType: "LEAD",
        entityId: id,
        before: { status: lead.status },
        after: { anonymized: true },
      }, tx);
      const found = await anonymizeLead(
        tx,
        { id, workspaceId: actor.workspaceId, orgId: actor.orgId },
        { userId: actor.userId },
      );
      if (!found) throw new HttpError(404, "Lead bulunamadı.");
    });
    return { ok: true, anonymized: true };
  });
}
