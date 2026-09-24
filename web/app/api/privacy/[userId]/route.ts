import { prisma } from "@admedic/database";
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
    return {
      lead: {
        ...lead,
        email: safeDecrypt(lead.email),
        phone: safeDecrypt(lead.phone),
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
      const lead = await tx.lead.findFirst({
        where: { id, workspaceId: actor.workspaceId, organizationId: actor.orgId },
        select: { id: true },
      });
      if (!lead) throw new HttpError(404, "Lead bulunamadı.");
      await tx.message.updateMany({
        where: { conversation: { leadId: id, workspaceId: actor.workspaceId } },
        data: { content: "[anonymized]", sender: null, metadata: {} },
      });
      await tx.conversation.updateMany({
        where: { leadId: id, workspaceId: actor.workspaceId },
        data: { status: "CLOSED", closedAt: new Date(), initiatedBy: null, escalatedTo: null },
      });
      await tx.consentRecord.updateMany({
        where: { leadId: id, workspaceId: actor.workspaceId },
        data: { status: "WITHDRAWN", withdrawnAt: new Date(), consentText: "[anonymized]", ip: null, userAgent: null },
      });
      await tx.lead.update({
        where: { id },
        data: {
          firstName: "[anonymized]", lastName: "[anonymized]", email: null,
          phone: null, country: null, lostReason: null, duplicateOf: null, metadata: {},
        },
      });
      await tx.auditLog.create({ data: {
        orgId: actor.orgId, workspaceId: actor.workspaceId, userId: actor.userId,
        action: "PRIVACY_ANONYMIZE", entityType: "LEAD", entityId: id,
        after: { anonymized: true },
      } });
    });
    return { ok: true, anonymized: true };
  });
}
