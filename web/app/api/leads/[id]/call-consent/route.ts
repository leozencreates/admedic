import { z } from "zod";
import { prisma } from "@admedic/database";
import { requireActor, requireRole, CARE_ROLES } from "../../../../_lib/auth";
import { logAudit } from "../../../../_lib/audit";
import { CALL_CONSENT_TEXT, CONSENT_EVIDENCE_BASES, type ConsentEvidenceBasis } from "../../../../_lib/consent-texts";
import { body, HttpError, respond, sameOrigin } from "../../../../_lib/http";

export const maxDuration = 10;

/**
 * Telefonla aranma rızası (ADR-0026). Rızayı hasta verir; personel yalnızca nasıl ve ne zaman alındığını kaydeder
 * (pazarlama rızasıyla aynı kanıt kuralı, KVKK İlke Kararı 2026/347). Sesli ajan bu kayıt olmadan aramaz.
 * Pazarlama rızasından ayrıdır: `Lead.consentGiven` değişmez.
 */
const Schema = z.discriminatedUnion("granted", [
  z
    .object({
      granted: z.literal(true),
      evidence: z
        .object({
          basis: z.enum(CONSENT_EVIDENCE_BASES.map((b) => b.value) as [ConsentEvidenceBasis, ...ConsentEvidenceBasis[]]),
          /** Rızanın alındığı gün (YYYY-MM-DD). */
          obtainedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          note: z.string().trim().max(500).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ granted: z.literal(false) }).strict(),
]);

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, CARE_ROLES);
    const { id } = await params;
    const input = await body(request, Schema);

    let obtainedAt: Date | null = null;
    if (input.granted) {
      // Günün öğlesi (Europe/Istanbul): gün kayması olmasın.
      obtainedAt = new Date(`${input.evidence.obtainedAt}T12:00:00+03:00`);
      if (Number.isNaN(obtainedAt.getTime())) throw new HttpError(422, "Rızanın alındığı tarih geçersiz. Tarihi yeniden seçin.");
      if (obtainedAt.getTime() > Date.now() + 12 * 3600_000)
        throw new HttpError(422, "Rızanın alındığı tarih ileri bir tarih olamaz. Bugün ya da daha önceki bir tarih seçin.");
    }

    await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({ where: { id, workspaceId: actor.workspaceId }, select: { id: true } });
      if (!lead) throw new HttpError(404, "Lead bulunamadı; silinmiş olabilir. Lead'ler sayfasından yeniden açın.");
      const where = { leadId: id, workspaceId: actor.workspaceId, type: "PHONE_CALL", status: "GRANTED" } as const;
      if (input.granted) {
        if (await tx.consentRecord.findFirst({ where, select: { id: true } })) return;
        await tx.consentRecord.create({
          data: {
            leadId: id,
            workspaceId: actor.workspaceId,
            type: "PHONE_CALL",
            status: "GRANTED",
            consentText: CALL_CONSENT_TEXT,
            acceptedAt: obtainedAt,
            source: "PANEL",
            evidence: {
              recordedBy: actor.userId,
              basis: input.evidence.basis,
              obtainedAt: obtainedAt!.toISOString(),
              ...(input.evidence.note ? { note: input.evidence.note } : {}),
            },
          },
        });
      } else {
        await tx.consentRecord.updateMany({ where, data: { status: "WITHDRAWN", withdrawnAt: new Date() } });
      }
      await logAudit(
        { actor, action: "LEAD_CALL_CONSENT_UPDATED", entityType: "LEAD", entityId: id, after: { granted: input.granted } },
        tx,
      );
    });
    return { ok: true, granted: input.granted };
  });
}
