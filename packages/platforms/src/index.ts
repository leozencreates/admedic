import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
export interface PlatformConnection {
  platform: string;
  status: string;
  connectedAt: Date;
}
export interface AdGroup {
  id: string;
  name: string;
  status: string;
  platform: string;
}
export async function getPlatforms(workspaceId: string): Promise<PlatformConnection[]> {
  const accounts = await prisma.adAccount.findMany({
    where: { workspaceId },
    select: { id: true, platform: true, status: true, connectedAt: true },
  });
  return accounts.map((a) => ({ platform: a.platform, status: a.status, connectedAt: a.connectedAt }));
}
export async function getGoogleAdsCampaigns(workspaceId: string): Promise<AdGroup[]> {
  loadEnv();
  const accounts = await prisma.adAccount.findMany({
    where: { workspaceId, platform: "GOOGLE_ADS" },
    include: { campaigns: { select: { id: true, name: true, status: true } } },
  });
  const campaigns: AdGroup[] = [];
  for (const account of accounts) {
    for (const campaign of account.campaigns ?? []) {
      campaigns.push({ id: campaign.id, name: campaign.name, status: campaign.status, platform: "GOOGLE_ADS" });
    }
  }
  return campaigns;
}
export async function getTikTokCampaigns(workspaceId: string): Promise<AdGroup[]> {
  loadEnv();
  const accounts = await prisma.adAccount.findMany({
    where: { workspaceId, platform: "TIKTOK" },
    include: { campaigns: { select: { id: true, name: true, status: true } } },
  });
  const campaigns: AdGroup[] = [];
  for (const account of accounts) {
    for (const campaign of account.campaigns ?? []) {
      campaigns.push({ id: campaign.id, name: campaign.name, status: campaign.status, platform: "TIKTOK" });
    }
  }
  return campaigns;
}
