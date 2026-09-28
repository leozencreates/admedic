import type { ReactNode } from "react";
import type { Metadata } from "next";
import { prisma } from "@admedic/database";
import { CARE_ROLES, currentActor, requirePageActor } from "../../_lib/auth";
import { t } from "../../_lib/i18n";
import { uiLanguage } from "../../_lib/page-meta";

/**
 * Sekme adı hastanın adını taşır ("James Carter · Lead CRM"); adı yalnızca kişisel veriyi
 * görebilen roller (CARE_ROLES) görür, diğerleri için genel başlık.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const lang = await uiLanguage();
  const actor = await currentActor();
  if (actor && CARE_ROLES.includes(actor.role)) {
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      select: { firstName: true, lastName: true },
    });
    const name = `${lead?.firstName ?? ""} ${lead?.lastName ?? ""}`.trim();
    if (name) return { title: `${name} · ${t("nav.leads", lang)}` };
  }
  return { title: t("title.leadDetail", lang) };
}

export default async function LeadDetailLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePageActor(`/leads/${encodeURIComponent(id)}`);
  return children;
}
