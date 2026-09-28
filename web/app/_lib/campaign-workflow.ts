import { prisma, type Prisma } from "@admedic/database";
import { HttpError } from "./http";
import type { Actor } from "./auth";
import { contentPolicyText } from "./campaign-content";

export async function ownedCampaign(actor: Actor, id: string, db: Prisma.TransactionClient = prisma) {
  const campaign = await db.campaign.findFirst({
    where: { id, workspaceId: actor.workspaceId, adAccount: { orgId: actor.orgId } },
    include: {
      adAccount: {
        select: { id: true, metaAccountId: true, connectionId: true, currency: true },
      },
    },
  });
  if (!campaign) throw new HttpError(404, "Kampanya bulunamadı; silinmiş olabilir. Kampanyalar sayfasından yeniden açın.");
  return campaign;
}

/**
 * Aynı kampanya üzerindeki eşzamanlı durum geçişlerini sıraya sokar
 * (`SELECT … FOR UPDATE`; satır yoksa `ownedCampaign` 404 üretir).
 * Yalnızca bir transaction istemcisiyle çağrılır.
 */
export async function lockCampaignRow(tx: Prisma.TransactionClient, actor: Actor, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "Campaign"
    WHERE "id" = ${id} AND "workspaceId" = ${actor.workspaceId} FOR UPDATE`;
}

/**
 * Politika kontrolüne beslenen kampanya metni: ad + (varsa) plan brief'i + bağlı onaylı içerik
 * (başlık, metin, açıklama, form soruları, WhatsApp karşılaması). Meta'ya giden metnin tamamı
 * her onay/yayın/etkinleştirme adımında taze kural setiyle yeniden kontrol edilir (ADR-0008).
 */
export function campaignPolicyText(campaign: { name: string; plan?: unknown; content?: unknown }): string {
  const plan = campaign.plan as { brief?: unknown } | null | undefined;
  const brief = typeof plan?.brief === "string" ? plan.brief : "";
  return [campaign.name, brief, contentPolicyText(campaign.content)].filter((s) => s.trim().length > 0).join("\n");
}

export interface ClinicPolicyContext {
  /** Aktif klinik profillerinin yasaklı ifadeleri (spec 3.5 katman 1: tenant yasaklı ifadeleri). */
  bannedPhrases: string[];
  /** Klinik pazar hedeflerinden (MarketTarget) ülke → diller; planlayıcı haritasını ezer. */
  marketLanguages: Record<string, string[]>;
}

/**
 * Çalışma alanının klinik profillerinden politika ve planlama bağlamı (salt okunur).
 */
export async function clinicPolicyContext(
  workspaceId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<ClinicPolicyContext> {
  const [clinics, targets] = await Promise.all([
    db.clinicProfile.findMany({
      where: { workspaceId, status: "ACTIVE" },
      select: { brandBannedPhrases: true },
    }),
    db.marketTarget.findMany({
      where: { clinic: { workspaceId, status: "ACTIVE" } },
      select: { country: true, language: true },
    }),
  ]);
  const bannedPhrases = Array.from(
    new Set(clinics.flatMap((c) => c.brandBannedPhrases).map((p) => p.trim()).filter(Boolean)),
  );
  const marketLanguages: Record<string, string[]> = {};
  for (const t of targets) {
    const key = t.country.trim().toUpperCase();
    if (!key) continue;
    const list = (marketLanguages[key] ??= []);
    if (!list.includes(t.language)) list.push(t.language);
  }
  return { bannedPhrases, marketLanguages };
}
