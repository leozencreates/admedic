import { prisma } from "@admedic/database";
import { HttpError } from "./http";
import type { Actor } from "./auth";

export async function ownedCampaign(actor: Actor, id: string) {
  const campaign = await prisma.campaign.findFirst({
    where: { id, workspaceId: actor.workspaceId },
    include: {
      adAccount: {
        select: { id: true, metaAccountId: true, connectionId: true },
      },
    },
  });
  if (!campaign) throw new HttpError(404, "Kampanya bulunamadı.");
  return campaign;
}