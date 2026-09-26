import { prisma } from "@admedic/database";

/**
 * Platform soyutlaması (spec §1 "Kapsam dışı (v1)": Google Ads / TikTok P2; mimari açık tutulur).
 * Şemada ayrı bir `platform` sütunu yoktur: `web/app/api/platforms/connect` platform adını
 * `AdAccount.name` alanına (META | GOOGLE_ADS | TIKTOK) yazar; Meta hesapları ayrıca
 * `connectionId` taşır. Bu paket aynı sözleşmeyi okur.
 */
export type PlatformCode = "META" | "GOOGLE_ADS" | "TIKTOK";
export const PLATFORM_CODES: readonly PlatformCode[] = ["META", "GOOGLE_ADS", "TIKTOK"];

export interface PlatformConnection {
  platform: PlatformCode;
  status: string;
  connectedAt: Date;
}
export interface AdGroup {
  id: string;
  name: string;
  status: string;
  platform: PlatformCode;
}

function platformOf(account: { name: string; connectionId: string | null }): PlatformCode {
  if (account.connectionId) return "META";
  return (PLATFORM_CODES as readonly string[]).includes(account.name) ? (account.name as PlatformCode) : "META";
}

export async function getPlatforms(workspaceId: string): Promise<PlatformConnection[]> {
  const accounts = await prisma.adAccount.findMany({
    where: { workspaceId },
    select: { id: true, name: true, connectionId: true, status: true, createdAt: true },
  });
  return accounts.map((a) => ({ platform: platformOf(a), status: a.status, connectedAt: a.createdAt }));
}

async function campaignsFor(workspaceId: string, platform: Exclude<PlatformCode, "META">): Promise<AdGroup[]> {
  const accounts = await prisma.adAccount.findMany({
    where: { workspaceId, name: platform, connectionId: null },
    select: { campaigns: { select: { id: true, name: true, status: true } } },
  });
  const campaigns: AdGroup[] = [];
  for (const account of accounts) {
    for (const campaign of account.campaigns) {
      campaigns.push({ id: campaign.id, name: campaign.name, status: campaign.status, platform });
    }
  }
  return campaigns;
}

export function getGoogleAdsCampaigns(workspaceId: string): Promise<AdGroup[]> {
  return campaignsFor(workspaceId, "GOOGLE_ADS");
}
export function getTikTokCampaigns(workspaceId: string): Promise<AdGroup[]> {
  return campaignsFor(workspaceId, "TIKTOK");
}
