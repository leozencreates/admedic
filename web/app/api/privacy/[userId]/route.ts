import { prisma, anonymizeLead } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../_lib/http";
import { decrypt } from "../../../_lib/encrypt";

// Legacy URL parameter name; the subject is a CRM lead, never a login user.
type Context = { params: Promise<{ userId: string }> };

function safeDecrypt(value: string | null): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    return "[şifre çözülemedi]";
  }
}

export async function GET(_request: Request, { params }: Context) {
  return respond(async () => {
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { userId: id } = await params;
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: actor.workspaceId, organizationId: actor.orgId },
      include: { conversations: { include: { messages: true } }, consentRecords: true },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı.");
    const leadData = {
      ...lead,
      email: safeDecrypt(lead.email),
      phone: safeDecrypt(lead.phone),
    };
    return {
      lead: leadData,
      export: {
        lead: leadData,
        conversations: lead.conversations.map((c) => ({
          id: c.id,
          channel: c.channel,
          status: c.status,
          initiatedBy: c.initiatedBy,
          messages: c.messages.map((m) => ({
            direction: m.direction,
            channel: m.channel,
            content: m.content,
            sender: m.sender,
            createdAt: m.createdAt,
          })),
        })),
        consentRecords: lead.consentRecords.map((cr) => ({
          type: cr.type,
          status: cr.status,
          // Rızanın nerede ve hangi dayanakla alındığı (ör. Meta Instant Form kutusu) veri sahibine de gösterilir.
          source: cr.source,
          basis:
            cr.evidence && typeof cr.evidence === "object" && !Array.isArray(cr.evidence)
              ? ((cr.evidence as Record<string, unknown>).basis ?? null)
              : null,
          consentText: cr.consentText,
          acceptedAt: cr.acceptedAt,
          withdrawnAt: cr.withdrawnAt,
        })),
        exportedAt: new Date().toISOString(),
      },
    };
  });
}

export async function DELETE(request: Request, { params }: Context) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { userId: id } = await params;
    await prisma.$transaction(async (tx) => {
      const found = await anonymizeLead(tx, { id, workspaceId: actor.workspaceId, orgId: actor.orgId }, { userId: actor.userId });
      if (!found) throw new HttpError(404, "Lead bulunamadı.");
    });
    return { ok: true, anonymized: true };
  });
}
