import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import pdfMake from "pdfmake/build/pdfmake";
import * as pdfFonts from "pdfmake/build/vfs_fonts";
import { Resend } from "resend";
import type { TDocumentDefinitions } from "pdfmake/interfaces";

pdfMake.vfs = pdfFonts as unknown as Record<string, string>;

export interface WeeklyReport {
  period: { start: string; end: string };
  summary: {
    totalSpend: number;
    totalImpressions: number;
    totalClicks: number;
    totalPurchases: number;
    ctr: number;
    cpl: number | null;
    newLeads: number;
    qualifiedLeads: number;
    totalLeads: number;
  };
  campaigns: { id: string; name: string; status: string; createdAt: string }[];
  unreadAlerts: { id: string; type: string; severity: string; title: string; createdAt: string }[];
}

export function reportPeriod(now = new Date(), reportDay = 0): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const diff = (start.getDay() - reportDay + 7) % 7;
  start.setDate(start.getDate() - diff);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export function isReportDay(now = new Date(), reportDay = 0): boolean {
  return now.getDay() === reportDay;
}

export async function buildWeeklyReport(
  workspaceId: string,
  now = new Date(),
  reportDay = 0,
): Promise<WeeklyReport> {
  const { start, end } = reportPeriod(now, reportDay);
  const [leads, insights, campaigns, alerts] = await Promise.all([
    prisma.lead.findMany({
      where: { workspaceId: { equals: workspaceId }, createdAt: { gte: start, lte: end } },
      select: { id: true, status: true },
    }),
    prisma.insightSnapshot.findMany({
      where: { workspaceId: { equals: workspaceId }, date: { gte: start, lte: end } },
      select: { spend: true, impressions: true, clicks: true, purchases: true },
    }),
    prisma.campaign.findMany({
      where: { workspaceId: { equals: workspaceId }, status: "ACTIVE" },
      select: { id: true, name: true, status: true, createdAt: true },
    }),
    prisma.alert.findMany({
      where: { workspaceId: { equals: workspaceId }, createdAt: { gte: start }, read: false },
      select: { id: true, type: true, severity: true, title: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  const totalSpend = insights.reduce((s, i) => s + i.spend, 0);
  const totalImpressions = insights.reduce((s, i) => s + i.impressions, 0);
  const totalClicks = insights.reduce((s, i) => s + i.clicks, 0);
  const totalPurchases = insights.reduce((s, i) => s + i.purchases, 0);
  const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
  const qualifiedCount = leads.filter((l) =>
    ["QUALIFIED", "CONSULTATION_BOOKED", "TRAVEL_PLANNED"].includes(l.status),
  ).length;
  const cpl = qualifiedCount > 0 ? Number((totalSpend / qualifiedCount / 100).toFixed(2)) : null;
  const newLeads = leads.filter((l) => l.status === "NEW").length;
  return {
    period: { start: start.toISOString(), end: end.toISOString() },
    summary: {
      totalSpend,
      totalImpressions,
      totalClicks,
      totalPurchases,
      ctr: Number(ctr.toFixed(4)),
      cpl,
      newLeads,
      qualifiedLeads: qualifiedCount,
      totalLeads: leads.length,
    },
    campaigns: campaigns.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
    unreadAlerts: alerts.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
  };
}

function tl(n: number | null | undefined): string {
  return n === null || n === undefined ? "-" : n.toLocaleString("tr-TR");
}

export function renderReportPdf(report: WeeklyReport): Promise<Buffer> {
  const doc: TDocumentDefinitions = {
    content: [
      { text: `Haftalık Reklam Raporu`, style: "h1" },
      {
        text: `${new Date(report.period.start).toLocaleDateString("tr-TR")} — ${new Date(report.period.end).toLocaleDateString("tr-TR")}`,
        style: "sub",
      },
      {
        text: `Bütçe: ${tl(report.summary.totalSpend)} · Gösterim: ${tl(report.summary.totalImpressions)} · Tıklama: ${tl(report.summary.totalClicks)} · Satın Alma: ${tl(report.summary.totalPurchases)}`,
        style: "body",
      },
      {
        text: `CTR: ${(report.summary.ctr * 100).toFixed(2)}% · CPL: ${report.summary.cpl ?? "-"}`,
        style: "body",
      },
      {
        text: `Yeni lead: ${report.summary.newLeads} · Nitelikli lead: ${report.summary.qualifiedLeads} · Toplam lead: ${report.summary.totalLeads}`,
        style: "body",
      },
      { text: "Aktif Kampanyalar", style: "h2" },
      report.campaigns.length
        ? {
            table: {
              headerRows: 1,
              widths: ["auto", "*"],
              body: [
                [
                  { text: "ID", style: "th" },
                  { text: "Ad", style: "th" },
                ],
                ...report.campaigns.map((c) => [{ text: c.id.slice(0, 8) }, { text: c.name }]),
              ],
            },
          }
        : { text: "Aktif kampanya yok.", style: "body" },
      { text: "Okunmamış Uyarılar", style: "h2" },
      report.unreadAlerts.length
        ? {
            ul: report.unreadAlerts.map((a) => `${a.type} · ${a.severity} — ${a.title}`),
          }
        : { text: "Okunmamış uyarı yok.", style: "body" },
    ],
    styles: {
      h1: { fontSize: 20, bold: true, margin: [0, 0, 0, 6] },
      h2: { fontSize: 14, bold: true, margin: [0, 16, 0, 6] },
      sub: { fontSize: 11, color: "#64748b", margin: [0, 0, 0, 12] },
      body: { fontSize: 11, margin: [0, 2, 0, 2] },
      th: { bold: true, fillColor: "#f1f5f9" },
    },
    defaultStyle: { font: "Roboto", fontSize: 11 },
  };
  return new Promise((resolve, reject) => {
    try {
      pdfMake.createPdf(doc).getBuffer((buffer) => {
        resolve(Buffer.from(buffer));
      });
    } catch (err) {
      reject(err);
    }
  });
}

export interface SendReportResult {
  id?: string;
  error?: string;
}

export async function sendWeeklyReportEmail(report: WeeklyReport, pdf: Buffer): Promise<SendReportResult> {
  const env = loadEnv();
  if (!env.RESEND_API_KEY) return { error: "RESEND_API_KEY yapılandırılmadı." };
  if (!env.WEEKLY_REPORT_RECIPIENT) return { error: "WEEKLY_REPORT_RECIPIENT yapılandırılmadı." };
  try {
    const resend = new Resend(env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      from: env.RESEND_FROM,
      to: [env.WEEKLY_REPORT_RECIPIENT],
      subject: `Haftalık Reklam Raporu — ${new Date(report.period.start).toLocaleDateString("tr-TR")}`,
      text: "Haftalık rapor ektedir. Özet: yeni lead " + report.summary.newLeads + ", harcama " + tl(report.summary.totalSpend) + ".",
      attachments: [
        {
          filename: `haftalik-rapor-${report.period.start.slice(0, 10)}.pdf`,
          content: pdf,
        },
      ],
    });
    if (error) return { error: typeof error.message === "string" ? error.message : String(error.message) };
    return data ? { id: data.id } : { error: "Bilinmeyen hata" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}