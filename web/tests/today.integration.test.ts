import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Role } from "@admedic/database";

import type { Actor } from "../app/_lib/auth";
import { changeDraft } from "../app/_lib/studio-service";
import { listCorrectionRequests } from "../app/_lib/pending-approvals";
import { setupSteps, todayQueue } from "../app/_lib/today";

/**
 * Bugün kuyruğu ve düzeltme istenenler (ADR-0018): içerik düzeltme isteğinin gerekçesi denetim kaydına yazılır
 * ve yalnızca gönderene döner; kuyruk role göre süzülür ve çalışma alanıyla sınırlıdır.
 */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("Bugün kuyruğu ve düzeltme istekleri", () => {
  const suffix = randomBytes(8).toString("hex");
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const actors: Partial<Record<Role, Actor>> = {};
  let workspaceId = "";
  let draftId = "";

  beforeAll(async () => {
    for (const foreign of [false, true]) {
      const org = await prisma.organization.create({
        data: {
          name: "Bugün fixture",
          slug: `today-${suffix}-${foreign}`,
          workspaces: { create: { name: "Bugün", slug: "bugun" } },
        },
        include: { workspaces: true },
      });
      orgIds.push(org.id);
      const wsId = org.workspaces[0].id;
      // Her iki çalışma alanında: yanıt bekleyen lead + devredilmiş, sahipsiz konuşma + kritik uyarı.
      const lead = await prisma.lead.create({
        data: { workspaceId: wsId, organizationId: org.id, firstName: "Bugün", lastName: suffix, channel: "WHATSAPP", status: "NEW" },
      });
      await prisma.conversation.create({
        data: { leadId: lead.id, workspaceId: wsId, channel: "WHATSAPP", status: "ESCALATED", escalatedTo: null, escalatedAt: new Date() },
      });
      // Konuşması olmayan yeni lead (Anında Form): yanıt bekler; devirden ayrı sayılır.
      await prisma.lead.create({
        data: { workspaceId: wsId, organizationId: org.id, firstName: "Form", lastName: suffix, channel: "LEAD_AD", status: "NEW" },
      });
      await prisma.alert.create({
        data: { workspaceId: wsId, type: "META_DISCONNECTED", severity: "CRITICAL", title: `Meta bağlantısı koptu ${foreign}`, message: "m" },
      });
      if (foreign) continue;
      workspaceId = wsId;
      for (const role of ["OWNER", "MEDIA_BUYER", "PATIENT_COORDINATOR"] as Role[]) {
        const user = await prisma.user.create({ data: { email: `${role.toLowerCase()}-today-${suffix}@example.invalid`, name: role } });
        userIds.push(user.id);
        await prisma.membership.create({ data: { orgId: org.id, userId: user.id, role } });
        actors[role] = { userId: user.id, orgId: org.id, workspaceId: wsId, role, workspaceName: "Bugün" };
      }
      const draft = await prisma.studioDraft.create({
        data: {
          workspaceId: wsId,
          name: "Almanya — Saç ekimi",
          content: {
            clinic: "Fixture clinic", service: "Services", market: "UK", language: "EN", budget: 700, duration: 7,
            variants: [
              { headline: "Meet the team", text: "Contact our team for service information.", cta: "Learn more" },
              { headline: "Discover services", text: "Contact our team for service information.", cta: "Learn more" },
            ],
          },
          policy: { version: 1, risk: "LOW", findings: [] },
          status: "IN_REVIEW",
          version: 3,
        },
      });
      draftId = draft.id;
      // Reklam uzmanı gönderdi (denetim kaydı DRAFT_SUBMIT).
      await prisma.auditLog.create({
        data: {
          orgId: org.id, workspaceId: wsId, userId: actors.MEDIA_BUYER!.userId, action: "DRAFT_SUBMIT",
          entityType: "STUDIO_DRAFT", entityId: draft.id, before: {}, after: { status: "IN_REVIEW" },
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("hesap sahibinin kuyruğunda kritik uyarı önce, sonra devir, onay ve yanıt bekleyen lead'ler; yabancı kayıt yok", async () => {
    const { items } = await todayQueue(actors.OWNER!);
    const kinds = items.map((i) => i.kind);
    expect(kinds[0]).toBe("Kritik uyarı");
    expect(items[0].title).toBe("Meta bağlantısı koptu false");
    expect(kinds).toContain("Hasta devri");
    expect(kinds).toContain("İçerik onayı");
    // Devredilen lead ayrı satırda; "yanıt bekliyor" özeti yalnızca form lead'ini sayar (ADR-0022).
    expect(items.find((i) => i.key === "leads-waiting")?.title).toBe("1 lead yanıt bekliyor");
    expect(kinds.indexOf("Hasta devri")).toBe(1);
    expect(items.some((i) => i.title.includes("true"))).toBe(false);
  });

  it("hasta koordinatörü yalnızca devir ve lead satırlarını görür", async () => {
    const { items } = await todayQueue(actors.PATIENT_COORDINATOR!);
    expect(new Set(items.map((i) => i.kind))).toEqual(new Set(["Hasta devri", "Lead'ler"]));
  });

  it("reklam uzmanı devir ve yanıt bekleyen lead satırlarını görmez (hastaya yazamaz, ADR-0022)", async () => {
    const { items } = await todayQueue(actors.MEDIA_BUYER!);
    expect(items.some((i) => i.kind === "Hasta devri" || i.key === "leads-waiting")).toBe(false);
  });

  it("düzeltme isteğinin gerekçesi yalnızca gönderene döner ve reklam uzmanının kuyruğuna düşer", async () => {
    await changeDraft(actors.OWNER!, draftId, { action: "reject", version: 3, reason: "Fiyat ifadesini kaldırın." });
    const forBuyer = await listCorrectionRequests(workspaceId, { userId: actors.MEDIA_BUYER!.userId });
    expect(forBuyer).toHaveLength(1);
    expect(forBuyer[0]).toMatchObject({ kind: "CONTENT", reason: "Fiyat ifadesini kaldırın.", rejectedBy: "OWNER" });
    expect(await listCorrectionRequests(workspaceId, { userId: actors.OWNER!.userId })).toEqual([]);
    const { items } = await todayQueue(actors.MEDIA_BUYER!);
    expect(items.find((i) => i.kind === "Düzeltme istendi")).toMatchObject({ context: "Gerekçe: Fiyat ifadesini kaldırın.", action: { label: "Düzelt" } });
  });

  it("kurulum rehberi eksik adımları gösterir", async () => {
    const steps = await setupSteps(actors.OWNER!);
    expect(steps.map((s) => s.key)).toEqual(["meta", "clinic", "privacy", "cap", "campaign"]);
    expect(steps.every((s) => !s.done)).toBe(true);
  });
});
