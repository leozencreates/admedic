import { prisma, type Role } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../_lib/http";

const ADMIN_ROLES: Role[] = ["OWNER", "ADMIN"];

export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ADMIN_ROLES);
    const { userId } = await params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) throw new HttpError(404, "Kullanıcı bulunamadı.");

    const [leads, conversations, consentRecords] = await Promise.all([
      prisma.lead.findMany({
        where: { workspaceId: actor.workspaceId },
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true,
          country: true, language: true, channel: true, status: true,
          createdAt: true, updatedAt: true,
        },
      }),
      prisma.conversation.findMany({
        where: { workspaceId: actor.workspaceId },
        select: {
          id: true, leadId: true, channel: true, status: true,
          initiatedBy: true, escalatedTo: true, escalatedAt: true,
          closedAt: true, createdAt: true, updatedAt: true,
        },
      }),
      prisma.consentRecord.findMany({
        where: { workspaceId: actor.workspaceId },
        select: {
          id: true, type: true, status: true, consentText: true,
          acceptedAt: true, withdrawnAt: true, ip: true, userAgent: true,
          createdAt: true, updatedAt: true,
        },
      }),
    ]);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      },
      leads,
      conversations,
      consentRecords,
    };
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ADMIN_ROLES);
    const { userId } = await params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) throw new HttpError(404, "Kullanıcı bulunamadı.");

    await prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          orgId: actor.orgId,
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          action: "PRIVACY_ANONYMIZE",
          entityType: "USER",
          entityId: userId,
          before: { email: user.email, name: user.name },
          after: { anonymized: true },
        },
      });

      const leads = await tx.lead.findMany({
        where: { workspaceId: actor.workspaceId },
        select: { id: true },
      });
      const leadIds = leads.map((l) => l.id);

      await tx.lead.updateMany({
        where: { id: { in: leadIds } },
        data: {
          firstName: "[anonymized]",
          lastName: "[anonymized]",
          email: null,
          phone: null,
          country: null,
          duplicateOf: "[anonymized]",
        },
      });

      const conversationIds = await tx.conversation.findMany({
        where: { leadId: { in: leadIds } },
        select: { id: true },
      });
      const convIds = conversationIds.map((c) => c.id);

      await tx.conversation.updateMany({
        where: { id: { in: convIds } },
        data: {
          initiatedBy: "[anonymized]",
          escalatedTo: null,
        },
      });

      await tx.message.updateMany({
        where: { conversationId: { in: convIds } },
        data: {
          content: "[anonymized]",
          sender: "[anonymized]",
        },
      });

      await tx.consentRecord.updateMany({
        where: { leadId: { in: leadIds } },
        data: {
          status: "WITHDRAWN",
          consentText: "[anonymized]",
          ip: null,
          userAgent: null,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          name: "[anonymized]",
          email: "[anonymized]@anonymized.invalid",
          passwordHash: null,
          image: null,
        },
      });
    });

    return { ok: true, anonymized: true };
  });
}
