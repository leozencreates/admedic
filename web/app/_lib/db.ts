import { prisma, type Workspace } from "@admedic/database";

export { prisma };

export async function getPrimaryWorkspace(): Promise<Workspace | null> {
  return prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
}

export function daysAgoUTC(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - days * 86_400_000);
}
