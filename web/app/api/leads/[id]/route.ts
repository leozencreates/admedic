import { prisma, anonymizeLead } from "@admedic/database";
import { CONSENT_EVIDENCE_BASES, DEFAULT_MARKETING_CONSENT_TEXT, type ConsentEvidenceBasis } from "../../../_lib/consent-texts";
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

/**
 * Panelden kaydedilen açık rızanın kanıtı (KVKK İlke Kararı 2026/347: ispat yükü veri sorumlusunda).
 * Rızayı hasta verir; personel yalnızca nasıl ve ne zaman alındığını kaydeder.
 */
const ConsentEvidenceSchema = z.object({
  basis: z.enum(CONSENT_EVIDENCE_BASES.map((b) => b.value) as [ConsentEvidenceBasis, ...ConsentEvidenceBasis[]]),
  /** Rızanın alındığı gün (YYYY-MM-DD) ya da tam zaman damgası. */
  obtainedAt: z.string().trim().min(10).max(40),
  note: z.string().trim().max(500).optional(),
}).strict();

const UpdateLeadSchema = z.object({
  status: LeadStatusEnum.optional(),
  lostReason: z.string().max(1000).nullable().optional(),
  metadata: z.record(z.any()).optional(),
  consentGiven: z.boolean().optional(),
  consentEvidence: ConsentEvidenceSchema.optional(),
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

/** Kuruluş açık rıza metni tanımlamadıysa kayda geçen rıza beyanı. */
const DEFAULT_CONSENT_TEXT = DEFAULT_MARKETING_CONSENT_TEXT;

/** "2026-09-28" → o günün öğlesi (Europe/Istanbul, gün kayması olmasın); tam zaman damgası olduğu gibi. */
function parseObtainedAt(value: string): Date | null {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00+03:00`) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface SourceRef {
  id: string;
  name: string;
}

/**
 * Lead'in kaynak kampanya/reklam seti/reklam adları. Lead'deki kimlikler Meta kimliğidir (Lead Ads
 * webhook'u, Click-to-Message referansı) ya da paneldeki kayıt kimliği (API ile oluşturulan lead);
 * ikisi de aranır ve yalnızca bu çalışma alanının kampanyaları eşleşir. Yalnızca reklam kimliği olan
 * lead'de (ör. WhatsApp/Messenger reklamından gelen) reklam seti ve kampanya reklamdan türetilir.
 */
async function resolveLeadSource(
  workspaceId: string,
  ids: { campaignId: string | null; adSetId: string | null; adId: string | null },
): Promise<{ campaign: SourceRef | null; adSet: SourceRef | null; ad: SourceRef | null }> {
  const inWorkspace = { workspaceId };
  const [campaign, adSet, ad] = await Promise.all([
    ids.campaignId
      ? prisma.campaign.findFirst({
          where: { ...inWorkspace, OR: [{ id: ids.campaignId }, { metaCampaignId: ids.campaignId }] },
          select: { id: true, name: true },
        })
      : null,
    ids.adSetId
      ? prisma.adSet.findFirst({
          where: { campaign: inWorkspace, OR: [{ id: ids.adSetId }, { metaAdSetId: ids.adSetId }] },
          select: { id: true, name: true, campaign: { select: { id: true, name: true } } },
        })
      : null,
    ids.adId
      ? prisma.ad.findFirst({
          where: { adSet: { campaign: inWorkspace }, OR: [{ id: ids.adId }, { metaAdId: ids.adId }] },
          select: {
            id: true,
            name: true,
            adSet: { select: { id: true, name: true, campaign: { select: { id: true, name: true } } } },
          },
        })
      : null,
  ]);
  const pick = (row: SourceRef | null | undefined): SourceRef | null => (row ? { id: row.id, name: row.name } : null);
  return {
    campaign: pick(campaign ?? adSet?.campaign ?? ad?.adSet.campaign),
    adSet: pick(adSet ?? ad?.adSet),
    ad: pick(ad),
  };
}

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
    if (!lead) throw new HttpError(404, "Lead bulunamadı; silinmiş olabilir. Lead'ler sayfasından yeniden açın.");
    const consents = await prisma.consentRecord.findMany({
      where: { leadId: lead.id, workspaceId: actor.workspaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true, type: true, status: true, source: true, consentText: true,
        acceptedAt: true, withdrawnAt: true, createdAt: true, evidence: true,
      },
    });
    const source = await resolveLeadSource(actor.workspaceId, {
      campaignId: lead.campaignId,
      adSetId: lead.adSetId,
      adId: lead.adId,
    });
    const meta = asRecord(lead.metadata);
    return { lead: {
      ...lead,
      ...presentContact(actor.role, { email: lead.email, phone: lead.phone }),
      metadata: sanitizeMetadata(lead.metadata),
      lookupHash: undefined,
      // Kaynak kampanya/reklam seti/reklamın paneldeki adı (kimlikler yalnızca "Teknik ayrıntı"da gösterilir).
      source,
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
          evidenceNote: typeof evidence.note === "string" ? evidence.note : null,
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
    if (!lead) throw new HttpError(404, "Lead bulunamadı; silinmiş olabilir. Lead'ler sayfasından yeniden açın.");

    const targetStatus = input.status ?? lead.status;
    if (input.lostReason !== undefined) {
      if (input.lostReason === null || !input.lostReason.trim())
        throw new HttpError(422, "Kayıp nedeni boş olamaz veya silinemez. Bir kayıp nedeni girin.");
      if (targetStatus !== "LOST")
        throw new HttpError(422, "Kayıp nedeni yalnızca lead kayıp olarak işaretlenirken ya da kayıp durumundayken girilebilir.");
    }
    if (input.status) {
      const allowed = VALID_TRANSITIONS[lead.status] ?? [];
      if (!allowed.includes(input.status)) {
        throw new HttpError(409, "Lead bu durumdan seçilen duruma geçirilemez. Sayfayı yenileyip geçerli bir durum seçin.");
      }
      if (input.status === "LOST" && !input.lostReason?.trim()) {
        throw new HttpError(422, "Lead'i kayıp olarak işaretlemek için kayıp nedeni girin.");
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

    // Açık rıza kaydı kanıtsız açılmaz: nasıl ve ne zaman alındığı zorunludur (İlke Kararı 2026/347).
    let consentObtainedAt: Date | null = null;
    if (input.consentGiven === true) {
      if (!input.consentEvidence)
        throw new HttpError(422, "Açık rızanın nasıl ve hangi tarihte alındığını girin.");
      consentObtainedAt = parseObtainedAt(input.consentEvidence.obtainedAt);
      if (!consentObtainedAt) throw new HttpError(422, "Rızanın alındığı tarih geçersiz. Tarihi yeniden seçin.");
      if (consentObtainedAt.getTime() > Date.now() + 5 * 60_000)
        throw new HttpError(422, "Rızanın alındığı tarih ileri bir tarih olamaz. Bugün ya da daha önceki bir tarih seçin.");
    } else if (input.consentEvidence) {
      throw new HttpError(422, "Rıza kanıtı yalnızca açık rıza kaydedilirken gönderilir.");
    }

    await prisma.$transaction(async (tx) => {
      if (contactChanged && nextHash && nextHash !== lead.lookupHash) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.orgId}), hashtext(${nextHash}))`;
        const clash = await tx.lead.findFirst({
          where: { organizationId: actor.orgId, lookupHash: nextHash, id: { not: id } },
          select: { id: true },
        });
        if (clash) throw new HttpError(409, "Bu telefon ya da e-posta başka bir lead'e kayıtlı. Lead'ler sayfasında mevcut kaydı bulup onu güncelleyin.");
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
              acceptedAt: consentObtainedAt ?? new Date(),
              ip: null,
              userAgent: null,
              // Panelden kaydedilen rıza: rızayı hasta verir; kaydeden kullanıcı, rızanın nasıl ve ne zaman
              // alındığı ve isteğe bağlı not kanıtta tutulur.
              source: "PANEL",
              evidence: {
                recordedBy: actor.userId,
                basis: input.consentEvidence?.basis ?? null,
                obtainedAt: consentObtainedAt?.toISOString() ?? null,
                ...(input.consentEvidence?.note ? { note: input.consentEvidence.note } : {}),
              },
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
      if (!lead) throw new HttpError(404, "Lead bulunamadı; silinmiş olabilir. Lead'ler sayfasından yeniden açın.");
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
      if (!found) throw new HttpError(404, "Lead bulunamadı; silinmiş olabilir. Lead'ler sayfasından yeniden açın.");
    });
    return { ok: true, anonymized: true };
  });
}
