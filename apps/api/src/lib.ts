import { z } from "zod";

import { prisma } from "@admedic/database";
export { prisma };

export type PrimaryWorkspace = {
  id: string;
  slug: string;
  name: string | null;
  currency: string;
};

/** Web panelin `getPrimaryWorkspace` ile aynı sözleşme: tek kiracılı klinik, ilk oluşturulan çalışma alanı. */
export async function getPrimaryWorkspace(): Promise<PrimaryWorkspace | null> {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  if (!ws) return null;
  return { id: ws.id, slug: ws.slug, name: ws.name, currency: ws.currency };
}

/** UTC günü başlangıcından `days` gün önce — meta insight snapshot'ları UTC gün bazlıdır (ADR-0001). */
export function daysAgoUTC(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - days * 86_400_000);
}

/** ROAS = conversionValue / spend (minor birim — oran birimsiz). spend <= 0 → null (bölen sıfır). */
export function roas(revenueMinor: number, spendMinor: number): number | null {
  if (spendMinor <= 0) return null;
  return Math.round((revenueMinor / spendMinor) * 1000) / 1000;
}

const daysQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});
type DaysQuery = z.infer<typeof daysQuery>;

export function parseDays(query: unknown): number {
  return daysQuery.safeParse(query).data?.days ?? 7;
}
