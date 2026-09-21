import { prisma } from "@admedic/database";
import { requireActor } from "../../../_lib/auth";
import { respond, sameOrigin } from "../../../_lib/http";
export const maxDuration = 30;
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);
    const [leads, insights, campaigns, alerts] = await Promise.all([
      prisma.lead.findMany({
        where: { workspaceId: { equals: actor.workspaceId }, createdAt: { gte: startOfWeek, lte: endOfWeek } },
        select: { id: true, status: true, channel: true, createdAt: true },
      }),
      prisma.insightSnapshot.findMany({
        where: { workspaceId: { equals: actor.workspaceId }, date: { gte: startOfWeek, lte: endOfWeek } },
        select: { date: true, spend: true, impressions: true, clicks: true, purchases: true, conversionValue: true },
        orderBy: { date: "asc" },
      }),
      prisma.campaign.findMany({
        where: { workspaceId: { equals: actor.workspaceId }, status: "ACTIVE" },
        select: { id: true, name: true, createdAt: true },
      }) as any,
      prisma.alert.findMany({
        where: { workspaceId: { equals: actor.workspaceId }, createdAt: { gte: startOfWeek }, read: false },
        select: { id: true, type: true, severity: true, title: true, createdAt: true },
        orderBy: { createdAt: "desc" }, take: 20,
      }),
    ]);
    const totalSpend = insights.reduce((s, i) => s + i.spend, 0);
    const totalImpressions = insights.reduce((s, i) => s + i.impressions, 0);
    const totalClicks = insights.reduce((s, i) => s + i.clicks, 0);
    const totalPurchases = insights.reduce((s, i) => s + i.purchases, 0);
    const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
    const qualifiedCount = leads.filter((l) => ["QUALIFIED", "CONSULTATION_BOOKED", "TRAVEL_PLANNED"].includes(l.status)).length;
    const cpl = qualifiedCount > 0 ? totalSpend / qualifiedCount : null;
    const newLeads = leads.filter((l) => l.status === "NEW").length;
    return {
      report: {
        period: { start: startOfWeek.toISOString(), end: endOfWeek.toISOString() },
        summary: {
          totalSpend, totalImpressions, totalClicks, totalPurchases,
          ctr: Number(ctr.toFixed(4)), cpl: cpl !== null ? Number((cpl / 100).toFixed(2)) : null,
          newLeads, qualifiedLeads: qualifiedCount, totalLeads: leads.length,
        },
        experiments: campaigns.map((e: { id: string; name: string; status: string; createdAt: Date }) => ({ id: e.id, name: e.name, status: e.status, createdAt: e.createdAt })),
        unreadAlerts: alerts.map((a) => ({ id: a.id, type: a.type, severity: a.severity, title: a.title, createdAt: a.createdAt })),
      },
    };
  });
}
