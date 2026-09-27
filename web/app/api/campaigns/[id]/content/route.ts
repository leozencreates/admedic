import { prisma, type Prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { lockCampaignRow, ownedCampaign } from "../../../../_lib/campaign-workflow";
import { ContentAttachSchema, contentLanguages, publishReadiness } from "../../../../_lib/campaign-content";
import { attachCampaignContent, summarizeContent } from "../../../../_lib/campaign-content-attach";

export const maxDuration = 15;

/**
 * Onaylı Kreatif Stüdyo taslaklarını (dil başına reklam metni) kampanyaya bağlar; isteğe bağlı
 * açılış sayfası bağlantısı (https) aynı kayda yazılır. Yalnızca DRAFT/REJECTED kampanyada.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const input = await body(request, ContentAttachSchema);
    return prisma.$transaction(async (tx) => {
      await lockCampaignRow(tx, actor, id);
      const campaign = await ownedCampaign(actor, id, tx);
      const result = await attachCampaignContent(tx, actor, campaign, input);
      const policyWarning =
        result.policy.risk === "MEDIUM" ? result.policy.findings.map((f) => f.reason).join("; ") : null;
      await logAudit({
        actor,
        action: "CAMPAIGN_CONTENT_ATTACHED",
        entityType: "CAMPAIGN",
        entityId: id,
        before: { draftIds: result.previousDraftIds, policyRisk: campaign.policyRisk },
        after: {
          draftIds: result.content.drafts.map((d) => d.draftId),
          languages: contentLanguages(result.content),
          landingUrl: result.content.landingUrl ?? null,
          policyRisk: result.policy.risk,
          policyWarning,
        } as Prisma.InputJsonValue,
      }, tx);
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: actor.orgId },
        select: { privacyPolicyUrl: true },
      });
      const readiness = publishReadiness({
        objective: campaign.objective,
        plan: campaign.plan,
        content: result.content,
        imageHash: campaign.imageHash,
        privacyPolicyUrl: org.privacyPolicyUrl,
      });
      return {
        campaign: {
          id,
          workflowStatus: campaign.workflowStatus,
          content: summarizeContent(result.content),
          policyRisk: result.policy.risk,
          policyWarning,
          warnings: result.warnings,
          readiness: { ready: readiness.ready, reasons: readiness.reasons, warnings: readiness.warnings },
        },
      };
    });
  });
}
