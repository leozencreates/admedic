import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Role } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE, type Actor } from "../app/_lib/auth";

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined),
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

import { GET as leadsGet } from "../app/api/leads/route";
import { GET as leadGet } from "../app/api/leads/[id]/route";
import { GET as messagesGet } from "../app/api/conversations/[id]/messages/route";
import { POST as aiChat } from "../app/api/ai/chat/route";
import { GET as alertsGet } from "../app/api/alerts/route";
import { GET as alertGet, PATCH as alertPatch } from "../app/api/alerts/[id]/route";
import { GET as shellGet } from "../app/api/shell/route";
import { GET as settingsGet } from "../app/api/org/settings/route";
import { todayQueue } from "../app/_lib/today";
import { HANDOFF_ALERT_TYPE } from "../app/_lib/lead-assistant";

function req(url: string, method: string, bodyObj?: unknown) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * Genel inceleme (2026-09-29) düzeltmeleri: hasta verisinin rol sınırları (lead ayrıntısı, eski mesaj ucu,
 * asistan ucu, uyarılar), rozetlerin rolün yapabileceği işi sayması, "Bugün" kuyruğunun rol ve tekrar kuralları
 * ve Lead'ler rozetiyle liste kümesinin aynı olması.
 */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("genel inceleme: rol sınırları ve tutarlılık", () => {
  const suffix = randomBytes(8).toString("hex");
  const tokens: Partial<Record<Role, string>> = {};
  const actors: Partial<Record<Role, Actor>> = {};
  const userIds: string[] = [];
  let orgId = "";
  let workspaceId = "";
  let leadId = "";
  let conversationId = "";
  let handoffLeadId = "";
  let closedHandoffLeadId = "";
  let oldWaitingLeadId = "";
  let handoffAlertId = "";
  let roasAlertId = "";
  const as = (role: Role) => cookieJar.set(SESSION_COOKIE, tokens[role]!);
  const ROLES: Role[] = ["OWNER", "ADMIN", "MEDIA_BUYER", "PATIENT_COORDINATOR", "ANALYST", "VIEWER"];

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: {
        name: "İnceleme",
        slug: `review-${suffix}`,
        reportRecipient: "rapor@example.invalid",
        workspaces: { create: { name: "Ws", slug: "ws-review" } },
      },
      include: { workspaces: true },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0].id;
    for (const role of ROLES) {
      const user = await prisma.user.create({ data: { email: `${role.toLowerCase()}-review-${suffix}@example.invalid`, name: role } });
      userIds.push(user.id);
      await prisma.membership.create({ data: { orgId, userId: user.id, role } });
      const token = randomBytes(32).toString("hex");
      await prisma.webSession.create({
        data: { tokenHash: tokenHash(token), userId: user.id, workspaceId, expiresAt: new Date(Date.now() + 300_000) },
      });
      tokens[role] = token;
      actors[role] = { userId: user.id, orgId, workspaceId, role, workspaceName: "Ws" };
    }

    // Asistanın yürüttüğü konuşma (hastanın mesajıyla).
    const lead = await prisma.lead.create({
      data: { workspaceId, organizationId: orgId, firstName: "Gizli", lastName: suffix, channel: "WHATSAPP", status: "CONTACTED" },
    });
    leadId = lead.id;
    const conversation = await prisma.conversation.create({ data: { leadId, workspaceId, channel: "WHATSAPP", status: "ACTIVE" } });
    conversationId = conversation.id;
    await prisma.message.create({
      data: { conversationId, direction: "INCOMING", channel: "WHATSAPP", content: "Tedavi geçmişim şöyle…", sender: "external" },
    });

    // Asistanın devrettiği, kimsenin devralmadığı konuşma + devir uyarısı.
    const handoffLead = await prisma.lead.create({
      data: { workspaceId, organizationId: orgId, firstName: "Devir", lastName: suffix, channel: "WHATSAPP", status: "CONTACTED" },
    });
    handoffLeadId = handoffLead.id;
    const handoff = await prisma.conversation.create({
      data: { leadId: handoffLeadId, workspaceId, channel: "WHATSAPP", status: "ESCALATED", escalatedAt: new Date(Date.now() - 3600_000) },
    });
    handoffAlertId = (
      await prisma.alert.create({
        data: {
          workspaceId, type: HANDOFF_ALERT_TYPE, severity: "CRITICAL", status: "OPEN",
          title: "Devir", message: "Asistan devretti.", entityType: "CONVERSATION", entityId: handoff.id,
        },
      })
    ).id;
    roasAlertId = (
      await prisma.alert.create({
        data: { workspaceId, type: "ROAS_DROP", severity: "CRITICAL", status: "OPEN", title: "ROAS düşüşü", message: "Düştü." },
      })
    ).id;

    // Kapanmış (kaybedilmiş) lead'in sahipsiz devri: "Bugün"de iş sayılmaz.
    const closed = await prisma.lead.create({
      data: { workspaceId, organizationId: orgId, firstName: "Kapalı", lastName: suffix, channel: "WHATSAPP", status: "LOST" },
    });
    closedHandoffLeadId = closed.id;
    await prisma.conversation.create({ data: { leadId: closed.id, workspaceId, channel: "WHATSAPP", status: "ESCALATED" } });

    // Rozet/liste kümesi: yanıt bekleyen eski bir lead, üzerine 100 yeni (asistanın yürüttüğü) lead.
    const old = await prisma.lead.create({
      data: {
        workspaceId, organizationId: orgId, firstName: "Eski", lastName: suffix, channel: "LEAD_AD", status: "NEW",
        createdAt: new Date(Date.now() - 10 * 86_400_000),
      },
    });
    oldWaitingLeadId = old.id;
    for (let i = 0; i < 100; i += 1) {
      const l = await prisma.lead.create({
        data: { workspaceId, organizationId: orgId, firstName: `Dolgu${i}`, lastName: suffix, channel: "WHATSAPP", status: "CONTACTED" },
      });
      await prisma.conversation.create({ data: { leadId: l.id, workspaceId, channel: "WHATSAPP", status: "ACTIVE" } });
    }

    // Etkinleştirme bekleyen kampanya (yöneticinin harcama yetkisi yok).
    const account = await prisma.adAccount.create({ data: { orgId, workspaceId, name: "Hesap", currency: "EUR" } });
    await prisma.campaign.create({
      data: { adAccountId: account.id, workspaceId, name: "Etkinleştirilecek", dailyBudget: 5000, workflowStatus: "PUBLISHED_PAUSED" },
    });
  }, 120_000);

  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("lead ayrıntısı mesaj döndürmez; izleyici lead kaydı göremez; düzenleme bayrağı role göre", async () => {
    as("OWNER");
    const owner = await (await leadGet(req(`/api/leads/${leadId}`, "GET"), ctx(leadId))).json();
    expect(owner.lead.conversations).toBeUndefined();
    expect(JSON.stringify(owner)).not.toContain("Tedavi geçmişim");
    expect(owner.canEdit).toBe(true);
    as("ANALYST");
    const analyst = await leadGet(req(`/api/leads/${leadId}`, "GET"), ctx(leadId));
    expect(analyst.status).toBe(200);
    expect((await analyst.json()).canEdit).toBe(false);
    as("VIEWER");
    expect((await leadGet(req(`/api/leads/${leadId}`, "GET"), ctx(leadId))).status).toBe(403);
    expect((await leadsGet()).status).toBe(403);
  });

  it("eski mesaj ucu yalnızca bakım rollerine açık", async () => {
    for (const role of ["VIEWER", "ANALYST"] as Role[]) {
      as(role);
      expect((await messagesGet(req(`/api/conversations/${conversationId}/messages`, "GET"), ctx(conversationId))).status).toBe(403);
    }
    as("MEDIA_BUYER");
    expect((await messagesGet(req(`/api/conversations/${conversationId}/messages`, "GET"), ctx(conversationId))).status).toBe(200);
  });

  it("reklam uzmanı asistan ucuyla hastaya yanıt gönderemez ya da konuşmaya kayıt ekleyemez", async () => {
    as("MEDIA_BUYER");
    const before = await prisma.message.count({ where: { conversationId } });
    expect((await aiChat(req("/api/ai/chat", "POST", { leadId }))).status).toBe(403);
    expect((await aiChat(req("/api/ai/chat", "POST", { leadId, message: "Acil!" }))).status).toBe(403);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(before);
  });

  it("uyarılar: izleyici göremez, koordinatör yalnızca devirleri görür; devir uyarısını reklam uzmanı kapatamaz", async () => {
    as("VIEWER");
    expect((await alertsGet(req("/api/alerts", "GET"))).status).toBe(403);
    as("PATIENT_COORDINATOR");
    const coord = await (await alertsGet(req("/api/alerts", "GET"))).json();
    expect(coord.alerts.map((a: { id: string }) => a.id)).toEqual([handoffAlertId]);
    expect((await alertGet(req(`/api/alerts/${roasAlertId}`, "GET"), ctx(roasAlertId))).status).toBe(404);
    as("MEDIA_BUYER");
    expect((await alertPatch(req(`/api/alerts/${handoffAlertId}`, "PATCH", { status: "RESOLVED" }), ctx(handoffAlertId))).status).toBe(403);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: handoffAlertId } })).status).toBe("OPEN");
    expect((await alertPatch(req(`/api/alerts/${roasAlertId}`, "PATCH", { status: "ACKED" }), ctx(roasAlertId))).status).toBe(200);
  });

  it("kabuk: reklam uzmanına Lead'ler rozeti yok; analistte uyarı rozeti listeyle aynı; yönetici yapamayacağı etkinleştirmeyi saymaz", async () => {
    as("MEDIA_BUYER");
    expect((await (await shellGet()).json()).counts.leads).toBe(0);
    as("PATIENT_COORDINATOR");
    const coord = await (await shellGet()).json();
    expect(coord.counts.leads).toBeGreaterThan(0);
    expect(coord.counts.alerts).toBe(1);
    as("ANALYST");
    const analyst = await (await shellGet()).json();
    expect(analyst.counts.alerts).toBe(analyst.notifications.length);
    as("ADMIN");
    expect((await (await shellGet()).json()).counts.approvals).toBe(0);
    as("OWNER");
    expect((await (await shellGet()).json()).counts.approvals).toBe(1);
  });

  it("rapor alıcısı e-postası yalnızca hesap sahibi ve yöneticiye döner", async () => {
    as("VIEWER");
    expect((await (await settingsGet()).json()).settings.reportRecipient).toBeNull();
    as("ADMIN");
    expect((await (await settingsGet()).json()).settings.reportRecipient).toBe("rapor@example.invalid");
  });

  it("Bugün: devir satırı yalnızca hastaya yazabilen rollerde, kapanmış lead hariç; yanıt bekleyenler satırı devri tekrar saymaz", async () => {
    const mb = await todayQueue(actors.MEDIA_BUYER!);
    expect(mb.items.some((i) => i.key.startsWith("handoff-") || i.key === "leads-waiting")).toBe(false);

    const owner = await todayQueue(actors.OWNER!);
    const handoffs = owner.items.filter((i) => i.key.startsWith("handoff-"));
    expect(handoffs.map((h) => h.action.href)).toEqual([`/leads/${handoffLeadId}`]);
    expect(handoffs[0].since).not.toBeNull();
    expect(owner.items.some((i) => i.action.href === `/leads/${closedHandoffLeadId}`)).toBe(false);
    // Yanıt bekleyenler: yalnızca eski NEW lead (devir ayrı satırda).
    expect(owner.items.find((i) => i.key === "leads-waiting")?.title).toBe("1 lead yanıt bekliyor");
    // Devir, sorunların hemen ardından ve diğer işlerden önce sıralanır.
    const handoffAt = owner.items.findIndex((i) => i.key.startsWith("handoff-"));
    const firstOther = owner.items.findIndex((i) => i.tone === "human" && !i.key.startsWith("handoff-"));
    expect(handoffAt).toBeLessThan(firstOther === -1 ? Infinity : firstOther);
    expect(owner.items.slice(0, handoffAt).every((i) => i.tone === "problem")).toBe(true);
  });

  it("Lead'ler listesi rozetle aynı kümeyi içerir: en yeni 100'ün dışında kalan yanıt bekleyen lead de listelenir", async () => {
    as("PATIENT_COORDINATOR");
    const shell = await (await shellGet()).json();
    const { leads } = await (await leadsGet()).json();
    const waiting = leads.filter((l: { inbox: { needsReply: boolean } | null }) => l.inbox?.needsReply);
    expect(leads.some((l: { id: string }) => l.id === oldWaitingLeadId)).toBe(true);
    expect(waiting.length).toBe(shell.counts.leads);
  });
});
