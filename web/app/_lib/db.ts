import { prisma, type Workspace } from "@admedic/database";
import { requirePageActor } from "./auth";

export { prisma };

export async function getPrimaryWorkspace(): Promise<Workspace | null> {
  const actor = await requirePageActor();
  return prisma.workspace.findUnique({ where: { id: actor.workspaceId } });
}

export function daysAgoUTC(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - days * 86_400_000);
}
