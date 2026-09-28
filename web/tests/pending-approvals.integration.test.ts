import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";

import { countPendingApprovals, listPendingApprovals } from "../app/_lib/pending-approvals";
import { alertRecordLinks, targetKey, targetNames } from "../app/_lib/record-refs";

/**
 * Onay işi (ADR-0016 · Faz 1 madde 11): Genel Bakış sayacı ve Onaylar sayfası gerçek onay işlerini sayar
 * (içerik, kampanya, etkinleştirme, bütçe önerisi); ajan kararları ve başka çalışma alanı sayılmaz.
 * Kayıt bağlantıları ve hedef adları da çalışma alanıyla sınırlıdır.
 */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("onay işi ve kayıt referansları", () => {
  const suffix = randomBytes(8).toString("hex");
  const orgs: string[] = [];
  const users: string[] = [];
  let workspaceId = "";
  let submitterId = "";
  const own = {
    draft: "",
    reviewCampaign: "",
    pausedCampaign: "",
    recommendation: "",
    experiment: "",
    adSet: "",
    ad: "",
    lead: "",
    conversation: "",
  };
  const foreign = { campaign: "", ad: "", conversation: "" };

  beforeAll(async () => {
    const submitter = await prisma.user.create({
      data: { email: `${suffix}-submitter@example.invalid`, name: "Onaya Gönderen" },
    });
    submitterId = submitter.id;
    users.push(submitter.id);

    for (const isForeign of [false, true]) {
      const org = await prisma.organization.create({
        data: {
          name: "Onay fixture",
          slug: `approvals-${suffix}-${isForeign}`,
          workspaces: { create: { name: "Onaylar", slug: "onaylar" } },
        },
        include: { workspaces: true },
      });
      orgs.push(org.id);
      const wsId = org.workspaces[0].id;
      const account = await prisma.adAccount.create({
        data: { orgId: org.id, workspaceId: wsId, name: "Hesap", currency: "EUR" },
      });
      // Her iki çalışma alanında da aynı bekleyen işler var; yabancı olan sayılmamalı.
      const draft = await prisma.studioDraft.create({
        data: {
          workspaceId: wsId,
          name: "İngiltere — Rinoplasti (EN)",
          content: {},
          policy: { version: 1, risk: "MEDIUM", findings: [] },
          status: "IN_REVIEW",
        },
      });
      const reviewCampaign = await prisma.campaign.create({
        data: {
          adAccountId: account.id,
          workspaceId: wsId,
          name: "Onay bekleyen kampanya",
          workflowStatus: "IN_REVIEW",
          dailyBudget: 5000,
          policyRisk: "LOW",
        },
      });
      const pausedCampaign = await prisma.campaign.create({
        data: {
          adAccountId: account.id,
          workspaceId: wsId,
          name: "Etkinleştirme bekleyen kampanya",
          workflowStatus: "PUBLISHED_PAUSED",
          status: "PAUSED",
          dailyBudget: 12000,
          metaCampaignId: `meta-${suffix}-${isForeign}`,
        },
      });
      const approvedDraft = await prisma.studioDraft.create({
        data: { workspaceId: wsId, name: "Onaylı içerik", content: {}, policy: {}, status: "APPROVED" },
      });
      const experiment = await prisma.studioExperiment.create({
        data: { draftId: approvedDraft.id, snapshot: {}, metrics: [], status: "COMPLETED" },
      });
      const recommendation = await prisma.recommendation.create({
        data: {
          workspaceId: wsId,
          experimentId: experiment.id,
          type: "BUDGET_INCREASE",
          status: "PENDING",
          priority: "HIGH",
          title: "Bütçeyi artırın",
          description: "d",
          reasoning: "r",
          action: {},
          expectedImpact: {},
        },
      });
      const adSet = await prisma.adSet.create({
        data: { campaignId: pausedCampaign.id, workspaceId: wsId, name: "Reklam seti 1" },
      });
      const ad = await prisma.ad.create({ data: { adSetId: adSet.id, workspaceId: wsId, name: "Reklam 1 (VAR)" } });
      const lead = await prisma.lead.create({
        data: { workspaceId: wsId, organizationId: org.id, firstName: "Ada", lastName: "Lovelace", language: "de", channel: "WHATSAPP" },
      });
      const conversation = await prisma.conversation.create({
        data: { leadId: lead.id, workspaceId: wsId, channel: "WHATSAPP", status: "ESCALATED" },
      });

      if (isForeign) {
        foreign.campaign = reviewCampaign.id;
        foreign.ad = ad.id;
        foreign.conversation = conversation.id;
        continue;
      }
      workspaceId = wsId;
      Object.assign(own, {
        draft: draft.id,
        reviewCampaign: reviewCampaign.id,
        pausedCampaign: pausedCampaign.id,
        recommendation: recommendation.id,
        experiment: experiment.id,
        adSet: adSet.id,
        ad: ad.id,
        lead: lead.id,
        conversation: conversation.id,
      });

      // Onay işi olmayan kayıtlar: taslak/yayındaki kampanya, onaylanmış öneri, onay bekleyen ajan kararı.
      await prisma.campaign.create({
        data: { adAccountId: account.id, workspaceId: wsId, name: "Taslak", workflowStatus: "DRAFT" },
      });
      await prisma.campaign.create({
        data: { adAccountId: account.id, workspaceId: wsId, name: "Yayında", workflowStatus: "ACTIVE", status: "ACTIVE" },
      });
      await prisma.recommendation.create({
        data: {
          workspaceId: wsId,
          experimentId: experiment.id,
          type: "BUDGET_DECREASE",
          status: "APPROVED",
          title: "Onaylı öneri",
          description: "d",
          reasoning: "r",
          action: {},
          expectedImpact: {},
        },
      });
      await prisma.agentDecision.create({
        data: { workspaceId: wsId, targetType: "AD", targetId: ad.id, action: "PAUSE", approval: "PENDING", reason: "r" },
      });
      await prisma.auditLog.createMany({
        data: [
          { orgId: org.id, workspaceId: wsId, userId: submitter.id, action: "DRAFT_SUBMIT", entityType: "STUDIO_DRAFT", entityId: draft.id, after: { status: "IN_REVIEW" } },
          { orgId: org.id, workspaceId: wsId, userId: submitter.id, action: "CAMPAIGN_SUBMITTED", entityType: "CAMPAIGN", entityId: reviewCampaign.id, after: { workflowStatus: "IN_REVIEW" } },
          { orgId: org.id, workspaceId: wsId, userId: submitter.id, action: "CAMPAIGN_PUBLISHED", entityType: "CAMPAIGN", entityId: pausedCampaign.id, after: { workflowStatus: "PUBLISHED_PAUSED" } },
          {
            orgId: org.id,
            workspaceId: wsId,
            userId: submitter.id,
            action: "RECOMMENDATIONS_GENERATED",
            entityType: "STUDIO_EXPERIMENT",
            entityId: experiment.id,
            after: { recommendations: [{ id: recommendation.id, type: "BUDGET_INCREASE", priority: "HIGH" }] },
          },
        ],
      });
    }
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it("yalnızca bu çalışma alanının gerçek onay işlerini sayar; ajan kararı sayılmaz", async () => {
    expect(await countPendingApprovals(workspaceId)).toEqual({
      total: 4,
      byKind: { CONTENT: 1, CAMPAIGN: 1, ACTIVATION: 1, RECOMMENDATION: 1 },
    });
  });

  it("her işin gönderenini, kimin işlem yapacağını ve kararın verildiği sayfayı verir", async () => {
    const { items } = await listPendingApprovals(workspaceId);
    expect(items.CONTENT).toHaveLength(1);
    expect(items.CONTENT[0]).toMatchObject({
      id: own.draft,
      title: "İngiltere — Rinoplasti (EN)",
      detail: "İçerik kontrolü: orta risk",
      submittedBy: "Onaya Gönderen",
      submittedByLabel: "Gönderen",
      actors: "Hesap sahibi veya Yönetici",
      href: `/studio?id=${own.draft}`,
    });
    expect(items.CAMPAIGN[0]).toMatchObject({
      id: own.reviewCampaign,
      detail: "Günlük bütçe: €50 · İçerik kontrolü: düşük risk",
      submittedBy: "Onaya Gönderen",
      actors: "Hesap sahibi veya Yönetici",
      href: `/campaign-planner?focus=${own.reviewCampaign}`,
    });
    expect(items.ACTIVATION[0]).toMatchObject({
      id: own.pausedCampaign,
      detail: "Etkinleştirilince günlük €120 harcama başlar.",
      submittedBy: "Onaya Gönderen",
      submittedByLabel: "Meta'ya yükleyen",
      actors: "Harcama yetkisi olanlar",
      href: `/campaign-planner?focus=${own.pausedCampaign}`,
    });
    expect(items.RECOMMENDATION).toHaveLength(1);
    expect(items.RECOMMENDATION[0]).toMatchObject({
      id: own.recommendation,
      detail: "Bütçe artışı · Yüksek öncelik",
      submittedBy: "Onaya Gönderen",
      submittedByLabel: "Oluşturan",
      actors: "Hesap sahibi veya Yönetici",
      href: "/recommendations",
    });
    // Denetim kaydı bekleme başlangıcıdır.
    const submitted = await prisma.auditLog.findFirstOrThrow({
      where: { workspaceId, action: "DRAFT_SUBMIT", entityId: own.draft, userId: submitterId },
    });
    expect(items.CONTENT[0].waitingSince.getTime()).toBe(submitted.createdAt.getTime());
  });

  it("uyarıyı ilgili kayda bağlar; başka çalışma alanının kaydına bağlantı vermez", async () => {
    const links = await alertRecordLinks(workspaceId, [
      { id: "ad", entityType: "AD", entityId: own.ad },
      { id: "adset", entityType: "ADSET", entityId: own.adSet },
      { id: "campaign", entityType: "CAMPAIGN", entityId: own.reviewCampaign },
      { id: "experiment", entityType: "EXPERIMENT", entityId: own.experiment },
      { id: "conversation", entityType: "CONVERSATION", entityId: own.conversation },
      { id: "foreign-campaign", entityType: "CAMPAIGN", entityId: foreign.campaign },
      { id: "foreign-ad", entityType: "AD", entityId: foreign.ad },
      { id: "foreign-conversation", entityType: "CONVERSATION", entityId: foreign.conversation },
      { id: "missing", entityType: "CAMPAIGN", entityId: "cmp_4" },
    ]);
    expect(Object.fromEntries(links)).toEqual({
      ad: `/campaign-planner?focus=${own.pausedCampaign}`,
      adset: `/campaign-planner?focus=${own.pausedCampaign}`,
      campaign: `/campaign-planner?focus=${own.reviewCampaign}`,
      experiment: `/tests/${own.experiment}`,
      conversation: `/leads/${own.lead}`,
    });
  });

  it("ajan kararı hedeflerine ad verir; başka çalışma alanının kaydı bilinmeyen kalır", async () => {
    const names = await targetNames(workspaceId, [
      { targetType: "AD", targetId: own.ad },
      { targetType: "ADSET", targetId: own.adSet },
      { targetType: "CAMPAIGN", targetId: own.pausedCampaign },
      { targetType: "AD", targetId: foreign.ad },
    ]);
    expect(names.get(targetKey("AD", own.ad))).toBe("Reklam 1 (VAR)");
    expect(names.get(targetKey("ADSET", own.adSet))).toBe("Reklam seti 1");
    expect(names.get(targetKey("CAMPAIGN", own.pausedCampaign))).toBe("Etkinleştirme bekleyen kampanya");
    expect(names.has(targetKey("AD", foreign.ad))).toBe(false);
  });
});
