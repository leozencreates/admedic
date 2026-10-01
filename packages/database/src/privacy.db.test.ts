import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "./index";
import { anonymizeExpiredLeads } from "./privacy";

/**
 * Saklama süresi (KVKK) gerçek veritabanında: süresi dolan lead seçilir ve anonimleştirilir.
 * Sahte istemcili test süzgecin SQL davranışını göremez; daha önce `metadata` içinde `anonymized` anahtarı olmayan
 * (yani bütün normal) lead'ler hiç seçilmiyordu.
 */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("saklama süresi anonimleştirmesi (DB)", () => {
  const suffix = randomBytes(6).toString("hex");
  const RETENTION_DAYS = 365;
  /** Bugün oluşturulan lead'lerin süresinin dolmuş sayıldığı an. */
  const later = new Date(Date.now() + 400 * 86_400_000);
  let orgId = "";
  let workspaceId = "";
  let otherWorkspaceId = "";
  const ids = { plain: "", flaggedFalse: "", recent: "", done: "", other: "", chatting: "", called: "" };
  const scope = () => ({ orgId, workspaceId, retentionDays: RETENTION_DAYS });

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: {
        name: "Retention fixture",
        slug: `retention-${suffix}`,
        workspaces: { create: [{ name: "A", slug: "a" }, { name: "B", slug: "b" }] },
      },
      include: { workspaces: { orderBy: { slug: "asc" } } },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0]!.id;
    otherWorkspaceId = org.workspaces[1]!.id;
    const lead = (data: { firstName: string; workspaceId?: string; metadata?: object; updatedAt?: Date }) =>
      prisma.lead.create({
        data: {
          workspaceId: data.workspaceId ?? workspaceId,
          organizationId: orgId,
          firstName: data.firstName,
          lastName: `Soyad-${randomBytes(3).toString("hex")}`,
          phone: `enc-${randomBytes(4).toString("hex")}`,
          interestedService: "Saç ekimi",
          ...(data.metadata ? { metadata: data.metadata } : {}),
          ...(data.updatedAt ? { updatedAt: data.updatedAt } : {}),
        },
      });
    // Uygulamanın oluşturduğu sıradan lead: metadata'da `anonymized` anahtarı yok.
    ids.plain = (await lead({ firstName: "Ayşe" })).id;
    ids.flaggedFalse = (await lead({ firstName: "Mehmet", metadata: { anonymized: false } })).id;
    // Süresi dolmamış: son güncellemesi kesim tarihinden sonra.
    ids.recent = (await lead({ firstName: "Yeni", updatedAt: new Date(later.getTime() - 10 * 86_400_000) })).id;
    ids.done = (await lead({ firstName: "[anonymized]", metadata: { anonymized: true } })).id;
    ids.other = (await lead({ firstName: "Başka", workspaceId: otherWorkspaceId })).id;
    const conversation = await prisma.conversation.create({ data: { leadId: ids.plain, workspaceId, channel: "WHATSAPP" } });
    await prisma.message.create({
      data: { conversationId: conversation.id, direction: "INCOMING", channel: "WHATSAPP", content: "Sağlık bilgisi içeren mesaj", sender: "external" },
    });
    // Lead kaydı eski ama görüşme sürüyor: kesim tarihinden sonra mesajı ya da sesli araması var.
    const afterCutoff = new Date(later.getTime() - 5 * 86_400_000);
    ids.chatting = (await lead({ firstName: "Yazışan" })).id;
    const active = await prisma.conversation.create({ data: { leadId: ids.chatting, workspaceId, channel: "WHATSAPP" } });
    await prisma.message.create({
      data: { conversationId: active.id, direction: "OUTGOING", channel: "WHATSAPP", content: "Ekibin yanıtı", sender: "staff", createdAt: afterCutoff },
    });
    ids.called = (await lead({ firstName: "Aranan" })).id;
    await prisma.voiceCall.create({
      data: { leadId: ids.called, workspaceId, organizationId: orgId, trigger: "MANUAL", status: "COMPLETED", createdAt: afterCutoff },
    });
  });
  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it("süre dolmadan hiçbir lead seçilmez", async () => {
    expect(await anonymizeExpiredLeads(prisma, scope(), { dryRun: true })).toBe(0);
    expect(await anonymizeExpiredLeads(prisma, scope())).toBe(0);
  });

  it("deneme sayımı yazmadan süresi dolan lead'leri sayar: anahtarsız lead dahil, zaten anonim ve yeni lead hariç", async () => {
    expect(await anonymizeExpiredLeads(prisma, scope(), { now: later, dryRun: true })).toBe(2);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ids.plain } })).firstName).toBe("Ayşe");
  });

  it("süresi dolan lead'leri anonimleştirir; yeni, zaten anonim ve başka çalışma alanındaki lead'e dokunmaz", async () => {
    expect(await anonymizeExpiredLeads(prisma, scope(), { now: later })).toBe(2);

    const plain = await prisma.lead.findUniqueOrThrow({ where: { id: ids.plain }, include: { conversations: { include: { messages: true } } } });
    expect(plain).toMatchObject({ firstName: "[anonymized]", lastName: "[anonymized]", phone: null, interestedService: null, metadata: { anonymized: true } });
    expect(plain.conversations[0]!.messages[0]!.content).toBe("[anonymized]");
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ids.flaggedFalse } })).firstName).toBe("[anonymized]");

    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ids.recent } })).firstName).toBe("Yeni");
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ids.other } })).firstName).toBe("Başka");
    // Süre son etkinlikten sayılır: yakın zamanda mesajı ya da araması olan lead korunur.
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ids.chatting } })).firstName).toBe("Yazışan");
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ids.called } })).firstName).toBe("Aranan");
    // Yalnızca yeni anonimleştirilen iki lead için denetim kaydı; zaten anonim olan yeniden işlenmedi.
    const audits = await prisma.auditLog.findMany({ where: { orgId, action: "PRIVACY_RETENTION_ANONYMIZE" } });
    expect(audits.map((a) => a.entityId).sort()).toEqual([ids.plain, ids.flaggedFalse].sort());
    expect(JSON.stringify(audits)).not.toContain("Ayşe");
  });

  it("ikinci tur aynı lead'leri yeniden işlemez", async () => {
    expect(await anonymizeExpiredLeads(prisma, scope(), { now: later })).toBe(0);
    expect(await prisma.auditLog.count({ where: { orgId, action: "PRIVACY_RETENTION_ANONYMIZE" } })).toBe(2);
  });
});
