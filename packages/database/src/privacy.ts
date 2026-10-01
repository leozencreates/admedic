import { Prisma, type PrismaClient } from "@prisma/client";

/** Anonimleştirilen lead'in ad ve soyadına yazılan yer tutucu; "zaten anonimleştirildi" ölçütü de budur. */
export const ANONYMIZED_NAME = "[anonymized]";

/** Shared by the privacy endpoint and retention jobs; never stores the old PII in audit. */
export async function anonymizeLead(
  tx: Prisma.TransactionClient,
  subject: { id: string; workspaceId: string; orgId: string },
  options: { userId?: string; retentionDays?: number; now?: Date } = {},
): Promise<boolean> {
  const where = { id: subject.id, workspaceId: subject.workspaceId, organizationId: subject.orgId };
  const lead = await tx.lead.findFirst({ where, select: { id: true } });
  if (!lead) return false;
  const now = options.now ?? new Date();
  await tx.message.updateMany({
    where: { conversation: { leadId: subject.id, workspaceId: subject.workspaceId } },
    data: { content: "[anonymized]", sender: null, metadata: {} },
  });
  await tx.conversation.updateMany({
    where: { leadId: subject.id, workspaceId: subject.workspaceId },
    data: { status: "CLOSED", closedAt: now, initiatedBy: null, escalatedTo: null, escalatedAt: null },
  });
  await tx.consentRecord.updateMany({
    where: { leadId: subject.id, workspaceId: subject.workspaceId },
    // Kanıt (form/leadgen kimlikleri) Meta'daki kişisel veriye bağ kurar: anonimleştirmede silinir.
    data: { status: "WITHDRAWN", withdrawnAt: now, consentText: "[anonymized]", ip: null, userAgent: null, evidence: Prisma.DbNull },
  });
  // Sesli arama özeti hasta verisi içerebilir; sağlayıcı kimlikleri de kişiye bağ kurar.
  await tx.voiceCall.updateMany({
    where: { leadId: subject.id, workspaceId: subject.workspaceId },
    data: { summary: null, conversationId: null, providerCallId: null },
  });
  await tx.lead.updateMany({
    where,
    data: {
      firstName: ANONYMIZED_NAME, lastName: ANONYMIZED_NAME, email: null, phone: null,
      country: null, language: "und", interestedService: null, lostReason: null,
      duplicateOf: null, lookupHash: null, consentGiven: false,
      campaignId: null, adSetId: null, adId: null, metadata: { anonymized: true },
    },
  });
  await tx.auditLog.create({ data: {
    orgId: subject.orgId, workspaceId: subject.workspaceId, userId: options.userId,
    action: options.retentionDays === undefined ? "PRIVACY_ANONYMIZE" : "PRIVACY_RETENTION_ANONYMIZE",
    entityType: "LEAD", entityId: subject.id,
    after: { anonymized: true, ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }) },
  } });
  return true;
}

export async function anonymizeExpiredLeads(
  db: PrismaClient,
  scope: { orgId: string; workspaceId: string; retentionDays: number },
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<number> {
  if (!Number.isInteger(scope.retentionDays) || scope.retentionDays <= 0) return 0;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - scope.retentionDays * 86_400_000);
  const where: Prisma.LeadWhereInput = {
    organizationId: scope.orgId, workspaceId: scope.workspaceId,
    updatedAt: { lt: cutoff },
    // Zaten anonimleştirilmiş lead yeniden işlenmez. Ölçüt, anonimleştirmenin yazdığı ad yer tutucusudur:
    // `NOT: { metadata: { path: ["anonymized"], equals: true } }` PostgreSQL'de anahtarı hiç olmayan satırı da
    // dışarıda bırakır (karşılaştırma NULL döner) ve normal lead'ler hiç seçilmezdi.
    firstName: { not: ANONYMIZED_NAME },
    // Süre son etkinlikten sayılır: lead kaydı eski olsa da kesim tarihinden sonra mesajı ya da sesli araması
    // olan lead hâlâ görüşülüyordur (gelen WhatsApp mesajı ve ekibin yanıtı lead satırını güncellemez).
    conversations: { none: { messages: { some: { createdAt: { gte: cutoff } } } } },
    voiceCalls: { none: { createdAt: { gte: cutoff } } },
  };
  const leads = await db.lead.findMany({ where, select: { id: true } });
  if (options.dryRun) return leads.length;
  let count = 0;
  for (const lead of leads) {
    count += await db.$transaction(async (tx) => {
      // A conversation may have become active since selection. Lock and recheck before erasure.
      await tx.$queryRaw`SELECT "id" FROM "Lead" WHERE "id" = ${lead.id}
        AND "workspaceId" = ${scope.workspaceId} AND "organizationId" = ${scope.orgId} FOR UPDATE`;
      if (!await tx.lead.findFirst({ where: { ...where, id: lead.id }, select: { id: true } })) return 0;
      return await anonymizeLead(tx, { id: lead.id, ...scope }, { retentionDays: scope.retentionDays, now }) ? 1 : 0;
    });
  }
  return count;
}
