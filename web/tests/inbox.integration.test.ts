import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Role } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

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
import { GET as conversationsGet } from "../app/api/conversations/[id]/route";
import { POST as escalate } from "../app/api/conversations/[id]/escalate/route";
import { POST as sendMessage } from "../app/api/leads/[id]/messages/route";

function req(url: string, method: string, bodyObj?: unknown) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * Lead gelen kutusu (ADR-0019): liste yanıtında gelen kutusu durumu ve role göre mesaj önizlemesi;
 * konuşma okuma yalnızca bakım rollerine; hastaya yazma ve devralma yalnızca Hesap sahibi, Yönetici ve
 * Hasta koordinatörüne (reklam uzmanı asistanın yürüttüğü konuşmayı da devralamaz).
 */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("lead gelen kutusu ve devralma yetkisi", () => {
  const suffix = randomBytes(8).toString("hex");
  const tokens: Partial<Record<Role, string>> = {};
  const userIds: string[] = [];
  let orgId = "";
  let workspaceId = "";
  let leadId = "";
  let conversationId = "";
  const as = (role: Role) => cookieJar.set(SESSION_COOKIE, tokens[role]!);

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: "Gelen kutusu", slug: `inbox-${suffix}`, workspaces: { create: { name: "Ws", slug: "ws-inbox" } } },
      include: { workspaces: true },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0].id;
    for (const role of ["OWNER", "MEDIA_BUYER", "PATIENT_COORDINATOR", "ANALYST", "VIEWER"] as Role[]) {
      const user = await prisma.user.create({ data: { email: `${role.toLowerCase()}-inbox-${suffix}@example.invalid`, name: role } });
      userIds.push(user.id);
      await prisma.membership.create({ data: { orgId, userId: user.id, role } });
      const token = randomBytes(32).toString("hex");
      await prisma.webSession.create({
        data: { tokenHash: tokenHash(token), userId: user.id, workspaceId, expiresAt: new Date(Date.now() + 120_000) },
      });
      tokens[role] = token;
    }
    // Asistanın yürüttüğü (ACTIVE) konuşma; hastanın gerçek mesajı 1 saat önce.
    const lead = await prisma.lead.create({
      data: { workspaceId, organizationId: orgId, firstName: "Kutu", lastName: suffix, channel: "WHATSAPP", status: "CONTACTED" },
    });
    leadId = lead.id;
    const conversation = await prisma.conversation.create({ data: { leadId, workspaceId, channel: "WHATSAPP", status: "ACTIVE" } });
    conversationId = conversation.id;
    await prisma.message.create({
      data: {
        conversationId, direction: "INCOMING", channel: "WHATSAPP", content: "Fiyat bilgisi alabilir miyim?",
        sender: "external", createdAt: new Date(Date.now() - 3600_000),
      },
    });
    // Konuşması olmayan yeni lead: yanıt bekler.
    await prisma.lead.create({ data: { workspaceId, organizationId: orgId, firstName: "Yeni", lastName: suffix, channel: "LEAD_AD", status: "NEW" } });
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("liste yanıtı gelen kutusu durumunu taşır; önizleme yalnızca bakım rollerine", async () => {
    as("PATIENT_COORDINATOR");
    const { leads } = await (await leadsGet()).json();
    const active = leads.find((l: { id: string }) => l.id === leadId);
    expect(active.inbox).toMatchObject({ conversationStatus: "ACTIVE", needsReply: false, lastMessage: { party: "lead", preview: "Fiyat bilgisi alabilir miyim?" } });
    const fresh = leads.find((l: { firstName: string }) => l.firstName === "Yeni");
    expect(fresh.inbox).toMatchObject({ needsReply: true, conversationStatus: null });
    as("ANALYST");
    const masked = (await (await leadsGet()).json()).leads.find((l: { id: string }) => l.id === leadId);
    expect(masked.inbox.lastMessage.preview).toBeNull();
  });

  it("konuşmayı yalnızca bakım rolleri okur; yanıtta pencere ve yazma yetkisi var", async () => {
    as("VIEWER");
    expect((await conversationsGet(req(`/api/conversations/${leadId}`, "GET"), ctx(leadId))).status).toBe(403);
    as("ANALYST");
    expect((await conversationsGet(req(`/api/conversations/${leadId}`, "GET"), ctx(leadId))).status).toBe(403);
    as("MEDIA_BUYER");
    const mb = await (await conversationsGet(req(`/api/conversations/${leadId}`, "GET"), ctx(leadId))).json();
    expect(mb.canReply).toBe(false);
    expect(mb.conversations[0].replyWindow).toMatchObject({ open: true });
    as("PATIENT_COORDINATOR");
    expect((await (await conversationsGet(req(`/api/conversations/${leadId}`, "GET"), ctx(leadId))).json()).canReply).toBe(true);
  });

  it("reklam uzmanı asistanın yürüttüğü konuşmayı devralamaz ve hastaya yazamaz", async () => {
    as("MEDIA_BUYER");
    expect((await escalate(req(`/api/conversations/${conversationId}/escalate`, "POST", {}), ctx(conversationId))).status).toBe(403);
    expect((await sendMessage(req(`/api/leads/${leadId}/messages`, "POST", { content: "Merhaba" }), ctx(leadId))).status).toBe(403);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).status).toBe("ACTIVE");
  });

  it("hasta koordinatörü devralır; liste 'Devralınan' durumunu gösterir", async () => {
    as("PATIENT_COORDINATOR");
    expect((await escalate(req(`/api/conversations/${conversationId}/escalate`, "POST", {}), ctx(conversationId))).status).toBe(200);
    const { leads } = await (await leadsGet()).json();
    expect(leads.find((l: { id: string }) => l.id === leadId).inbox).toMatchObject({
      conversationStatus: "ESCALATED",
      claimedBy: "PATIENT_COORDINATOR",
      claimedByMe: true,
      // Son mesaj hastadan: devralan kişiden yanıt bekleniyor.
      needsReply: true,
    });
  });
});
