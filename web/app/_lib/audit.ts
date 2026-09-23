import { prisma, Prisma } from "@admedic/database";
import type { Actor } from "./auth";

type AuditInput = {
  actor: Pick<Actor, "orgId" | "workspaceId" | "userId">;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
};

export async function logAudit(input: AuditInput) {
  await prisma.auditLog.create({
    data: {
      orgId: input.actor.orgId,
      workspaceId: input.actor.workspaceId,
      userId: input.actor.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: (input.before ?? Prisma.DbNull) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
      after: (input.after ?? Prisma.DbNull) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
    },
  });
}