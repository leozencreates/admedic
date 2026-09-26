import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { loadEnv, type AppEnv } from "@admedic/config";
import { prisma } from "@admedic/database";

export { prisma };

export type PrimaryWorkspace = {
  id: string;
  slug: string;
  name: string | null;
  currency: string;
};

/** Servis adı sabit yazılmaz (spec §9): `${APP_NAME} API`. */
export function serviceName(env: AppEnv = loadEnv()): string {
  return `${env.APP_NAME} API`;
}

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

/** `?days=` sorgusu (1–90, varsayılan 7) — tek yerde tanımlı. */
export function parseDays(query: unknown): number {
  const parsed = daysQuery.safeParse(query);
  return parsed.success ? parsed.data.days : 7;
}

export type CampaignSummary = {
  id: string;
  name: string;
  status: string;
  /** Günlük bütçe, minor unit (ADR-0011). */
  dailyBudgetCents: number;
  adAccount: { name: string; currency: string };
  adSetCount: number;
  lastNDays: { spendCents: number; revenueCents: number; purchases: number; clicks: number; roas: number | null };
};

/** Kampanya listesi + son N gün özetleri; `/v1/overview` ve `/v1/campaigns` ortak kullanır. */
export async function campaignSummaries(workspaceId: string, days: number): Promise<CampaignSummary[]> {
  const since = daysAgoUTC(days - 1);
  const [campaigns, grouped] = await Promise.all([
    prisma.campaign.findMany({
      where: { workspaceId },
      include: { adAccount: { select: { name: true, currency: true } }, _count: { select: { adsets: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.insightSnapshot.groupBy({
      by: ["campaignId"],
      where: { workspaceId, date: { gte: since }, campaignId: { not: null } },
      _sum: { spend: true, conversionValue: true, purchases: true, clicks: true },
    }),
  ]);
  const byCampaign = new Map(grouped.map((g) => [g.campaignId, g._sum]));
  return campaigns.map((c) => {
    const sum = byCampaign.get(c.id);
    const spend = sum?.spend ?? 0;
    const revenue = sum?.conversionValue ?? 0;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      dailyBudgetCents: c.dailyBudget ?? 0,
      adAccount: c.adAccount,
      adSetCount: c._count.adsets,
      lastNDays: {
        spendCents: spend,
        revenueCents: revenue,
        purchases: sum?.purchases ?? 0,
        clicks: sum?.clicks ?? 0,
        roas: roas(revenue, spend),
      },
    };
  });
}

/** `Authorization: Bearer <token>` başlığından belirteci ayıklar. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

/** Sabit zamanlı belirteç karşılaştırması. */
export function tokenMatches(candidate: string | null, expected: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type ApiAuthDecision = { ok: true } | { ok: false; status: 401 | 503; message: string };

/**
 * `API_TOKEN` politikası: belirteç ayarlıysa Bearer zorunlu (401); ayarlı değilse yalnızca mock modda
 * belirteçsiz erişime izin verilir, aksi halde 503 (yanlışlıkla açık API'yi önler).
 */
export function authorizeApiRequest(authorization: string | undefined, env: AppEnv = loadEnv()): ApiAuthDecision {
  if (!env.API_TOKEN) {
    if (env.META_MOCK_MODE) return { ok: true };
    return { ok: false, status: 503, message: "API_TOKEN ayarlanmadı; API yalnızca mock modunda belirteçsiz yanıt verir." };
  }
  if (!tokenMatches(bearerToken(authorization), env.API_TOKEN)) {
    return { ok: false, status: 401, message: "Geçersiz veya eksik API belirteci (Authorization: Bearer)." };
  }
  return { ok: true };
}

/** CORS'a izin verilen kaynaklar: panel (`AUTH_URL`) ve Tauri masaüstü kabuğu. */
export function allowedOrigins(env: AppEnv = loadEnv()): string[] {
  const origins = new Set<string>(["tauri://localhost", "http://tauri.localhost"]);
  try {
    origins.add(new URL(env.AUTH_URL).origin);
  } catch {
    // AUTH_URL geçersizse yalnızca masaüstü kaynakları kalır.
  }
  return [...origins];
}
