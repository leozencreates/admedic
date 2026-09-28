import type { ReactNode } from "react";
import type { Metadata } from "next";
import { prisma } from "@admedic/database";
import { currentActor, requirePageActor } from "../../_lib/auth";
import { t } from "../../_lib/i18n";
import { uiLanguage } from "../../_lib/page-meta";

/**
 * Sekme adı kampanyanın adını taşır ("Almanya — Saç ekimi · Kampanyalar"); kampanya oturumdaki
 * çalışma alanına ait değilse (ya da yoksa) genel başlık.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const lang = await uiLanguage();
  const section = t("nav.campaigns", lang);
  const actor = await currentActor();
  if (actor) {
    const campaign = await prisma.campaign.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      select: { name: true },
    });
    if (campaign?.name) return { title: `${campaign.name} · ${section}` };
  }
  return { title: section };
}

export default async function CampaignDetailLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePageActor(`/campaigns/${encodeURIComponent(id)}`);
  return children;
}
