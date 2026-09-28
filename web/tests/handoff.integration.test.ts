import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Role } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";
import { encrypt } from "../app/_lib/encrypt";

const { cookieJar } = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) =>
      cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined,
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

import { POST as escalate } from "../app/api/conversations/[id]/escalate/route";
import { GET as conversationsGet } from "../app/api/conversations/[id]/route";
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
 * Faz 1 "devir gerçeği": asistanın devrettiği konuşma (ESCALATED, escalatedTo boş) devralınana kadar
 * sahipsiz görünür; devralma düğmeyle ya da ilk yanıtla olur, uyarıyı çözer ve bir kez yapılabilir.
 */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("conversation handoff (assistant → team)", () => {
  const suffix = randomBytes(8).toString("hex");
  const tokens: Partial<Record<Role, string>> = {};
  const users: Partial<Record<Role, string>> = {};
  const userIds: string[] = [];
  let orgId = "";
  let workspaceId = "";
  const handedOffAt = new Date(Date.now() - 42 * 60_000);

  const as = (role: Role) => cookieJar.set(SESSION_COOKIE, tokens[role]!);

  /** Asistanın devrettiği WhatsApp konuşması + açık "asistan devretti" uyarısı. */
  async function assistantHandoff(options: { inbound?: boolean } = {}) {
    const lead = await prisma.lead.create({
      data: {
        workspaceId, organizationId: orgId, firstName: "Devir", lastName: suffix,
        phone: encrypt(`+90532${Math.floor(1_000_000 + Math.random() * 8_999_999)}`), channel: "WHATSAPP", status: "NEW",
      },
    });
    const conversation = await prisma.conversation.create({
      data: {
        leadId: lead.id, workspaceId, channel: "WHATSAPP", status: "ESCALATED",
        escalatedTo: null, escalatedAt: handedOffAt, initiatedBy: "bot",
      },
    });
    if (options.inbound !== false) {
      await prisma.message.create({
        data: { conversationId: conversation.id, direction: "INCOMING", channel: "WHATSAPP", content: "Fiyat nedir?", sender: "external" },
      });
    }
    const alert = await prisma.alert.create({
      data: {
        workspaceId, type: "CONVERSATION_ESCALATED", severity: "WARNING",
        title: "Asistan konuşmayı koordinatöre devretti", message: "m",
        entityType: "CONVERSATION", entityId: conversation.id,
      },
    });
    return { lead, conversation, alert };
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: {
        name: "Handoff fixture",
        slug: `handoff-${suffix}`,
        workspaces: { create: { name: "Ws", slug: "ws-handoff" } },
      },
      include: { workspaces: true },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0].id;
    const names: Partial<Record<Role, string | null>> = {
      OWNER: "Selin Yönetici",
      PATIENT_COORDINATOR: "Ayşe Koordinatör",
      MEDIA_BUYER: null,
    };
    for (const role of ["OWNER", "PATIENT_COORDINATOR", "MEDIA_BUYER"] as Role[]) {
      const user = await prisma.user.create({
        data: { email: `${role.toLowerCase()}-handoff-${suffix}@example.invalid`, name: names[role] ?? null },
      });
      userIds.push(user.id);
      users[role] = user.id;
      await prisma.membership.create({ data: { orgId, userId: user.id, role } });
      const token = randomBytes(32).toString("hex");
      await prisma.webSession.create({
        data: { tokenHash: tokenHash(token), userId: user.id, workspaceId, expiresAt: new Date(Date.now() + 120_000) },
      });
      tokens[role] = token;
    }
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("shows an assistant handoff as unclaimed, lets a coordinator claim it once and resolves the alert", async () => {
    const { lead, conversation, alert } = await assistantHandoff();

    as("PATIENT_COORDINATOR");
    const before = await (await conversationsGet(req(`/api/conversations/${lead.id}`, "GET"), ctx(lead.id))).json();
    expect(before.conversations[0]).toMatchObject({
      id: conversation.id, status: "ESCALATED", escalatedTo: null, escalatedToName: null, escalatedToIsMe: false,
    });

    const res = await escalate(req(`/api/conversations/${conversation.id}/escalate`, "POST", {}), ctx(conversation.id));
    expect(res.status).toBe(200);
    expect((await res.json()).conversation).toMatchObject({
      id: conversation.id, status: "ESCALATED", escalatedTo: users.PATIENT_COORDINATOR, claimed: true,
    });

    const claimed = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(claimed.status).toBe("ESCALATED");
    expect(claimed.escalatedTo).toBe(users.PATIENT_COORDINATOR);
    // Asistanın devir anı korunur (bekleme süresi ölçümü bozulmaz).
    expect(claimed.escalatedAt?.toISOString()).toBe(handedOffAt.toISOString());

    const note = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, sender: "system" } });
    expect(note.content).toBe("Konuşma Ayşe Koordinatör tarafından devralındı.");
    expect(note.direction).toBe("OUTGOING");

    const resolved = await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.read).toBe(true);
    expect(resolved.resolvedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "CONVERSATION_CLAIMED", entityId: conversation.id } });
    expect(audit.userId).toBe(users.PATIENT_COORDINATOR);
    expect(audit.after).toMatchObject({ escalatedTo: users.PATIENT_COORDINATOR, via: "button", resolvedAlertIds: [alert.id] });

    // Devralan kişi GET'te "siz", başkası adıyla görür.
    const mine = await (await conversationsGet(req(`/api/conversations/${lead.id}`, "GET"), ctx(lead.id))).json();
    expect(mine.conversations[0]).toMatchObject({ escalatedToName: "Ayşe Koordinatör", escalatedToIsMe: true });

    // İkinci devralma 409: başkası için devralanın adıyla, devralan için "siz".
    const again = await escalate(req(`/api/conversations/${conversation.id}/escalate`, "POST", {}), ctx(conversation.id));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("Konuşmayı zaten siz devraldınız.");
    as("OWNER");
    const theirs = await (await conversationsGet(req(`/api/conversations/${lead.id}`, "GET"), ctx(lead.id))).json();
    expect(theirs.conversations[0]).toMatchObject({ escalatedToName: "Ayşe Koordinatör", escalatedToIsMe: false });
    const second = await escalate(req(`/api/conversations/${conversation.id}/escalate`, "POST", {}), ctx(conversation.id));
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("Konuşma zaten Ayşe Koordinatör tarafından devralındı.");
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).escalatedTo).toBe(users.PATIENT_COORDINATOR);
    expect(await prisma.message.count({ where: { conversationId: conversation.id, sender: "system" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "CONVERSATION_CLAIMED", entityId: conversation.id } })).toBe(1);
  });

  it("does not let a media buyer claim an assistant handoff", async () => {
    const { conversation, alert } = await assistantHandoff();
    as("MEDIA_BUYER");
    const res = await escalate(req(`/api/conversations/${conversation.id}/escalate`, "POST", {}), ctx(conversation.id));
    expect(res.status).toBe(403);
    const unchanged = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(unchanged.escalatedTo).toBeNull();
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("OPEN");
    expect(await prisma.message.count({ where: { conversationId: conversation.id, sender: "system" } })).toBe(0);
    // Yanıt da veremez (devredilmiş konuşmada yazma ESCALATION_ROLES'a açık).
    const reply = await sendMessage(req(`/api/leads/${conversation.leadId}/messages`, "POST", { content: "Merhaba" }), ctx(conversation.id));
    expect(reply.status).toBe(403);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).escalatedTo).toBeNull();
  });

  it("claims an unclaimed handoff for the coordinator who replies, note first", async () => {
    const { lead, conversation, alert } = await assistantHandoff();
    as("OWNER");
    const res = await sendMessage(req(`/api/leads/${lead.id}/messages`, "POST", { content: "Merhaba, fiyat bilgisini paylaşıyorum." }), ctx(lead.id));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.conversation).toMatchObject({
      id: conversation.id, status: "ESCALATED", escalatedTo: users.OWNER, takenOver: false, claimed: true,
    });
    const claimed = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(claimed.escalatedTo).toBe(users.OWNER);
    expect(claimed.escalatedAt?.toISOString()).toBe(handedOffAt.toISOString());
    expect(claimed.firstResponseAt).not.toBeNull();
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("RESOLVED");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "CONVERSATION_CLAIMED", entityId: conversation.id } });
    expect(audit.after).toMatchObject({ via: "message", escalatedTo: users.OWNER });
    expect(await prisma.auditLog.count({ where: { action: "MESSAGE_SENT", entityId: conversation.id } })).toBe(1);

    // Panelde sıra: gelen mesaj → "X devraldı" notu → X'in yanıtı (GET yeniden eskiye döner).
    const listed = await (await conversationsGet(req(`/api/conversations/${lead.id}`, "GET"), ctx(lead.id))).json();
    const [reply, note, inbound] = listed.conversations[0].messages;
    expect(reply).toMatchObject({ sender: users.OWNER, content: "Merhaba, fiyat bilgisini paylaşıyorum." });
    expect(note).toMatchObject({ sender: "system", content: "Konuşma Selin Yönetici tarafından devralındı." });
    expect(inbound).toMatchObject({ direction: "INCOMING" });
    expect(listed.conversations[0]).toMatchObject({ escalatedToName: "Selin Yönetici", escalatedToIsMe: true });

    // Sonraki yanıtlar yeniden devralmaz; başka koordinatör yazabilir ama sahip değişmez.
    as("PATIENT_COORDINATOR");
    const next = await sendMessage(req(`/api/leads/${lead.id}/messages`, "POST", { content: "Ben de buradayım." }), ctx(lead.id));
    expect(next.status).toBe(200);
    expect((await next.json()).conversation).toMatchObject({ escalatedTo: users.OWNER, claimed: false });
    expect(await prisma.message.count({ where: { conversationId: conversation.id, sender: "system" } })).toBe(1);
  });

  it("keeps the 24-hour rule when replying to a handoff: no claim without a sendable message", async () => {
    const { lead, conversation, alert } = await assistantHandoff({ inbound: false });
    as("PATIENT_COORDINATOR");
    // Gerçek gelen mesaj yok → serbest metin reddedilir, devralma yazılmaz.
    const blocked = await sendMessage(req(`/api/leads/${lead.id}/messages`, "POST", { content: "Merhaba" }), ctx(lead.id));
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toContain("pencere");
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).escalatedTo).toBeNull();
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("OPEN");
    // Onaylı şablon pencere dışında gider ve konuşmayı devralır.
    const template = await sendMessage(
      req(`/api/leads/${lead.id}/messages`, "POST", { templateName: "randevu_hatirlatma", templateParams: { "1": "Ayşe" } }),
      ctx(lead.id),
    );
    expect(template.status).toBe(200);
    expect((await template.json()).conversation).toMatchObject({ claimed: true, escalatedTo: users.PATIENT_COORDINATOR });
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("RESOLVED");
  });

  it("rejects claiming a closed conversation and resolves open handoff alerts on a manual takeover", async () => {
    const { conversation } = await assistantHandoff();
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "CLOSED", closedAt: new Date() } });
    as("OWNER");
    const closed = await escalate(req(`/api/conversations/${conversation.id}/escalate`, "POST", {}), ctx(conversation.id));
    expect(closed.status).toBe(409);
    expect((await closed.json()).error).toBe("Kapalı konuşma devralınamaz.");

    // Asistan yanıtlarken (ACTIVE) açılmış "yanıt üretemedi" uyarısı, ekip konuşmayı devralınca çözülür.
    const lead = await prisma.lead.create({
      data: { workspaceId, organizationId: orgId, firstName: "Aktif", lastName: suffix, channel: "WHATSAPP", status: "NEW" },
    });
    const active = await prisma.conversation.create({ data: { leadId: lead.id, workspaceId, channel: "WHATSAPP", status: "ACTIVE" } });
    const failed = await prisma.alert.create({
      data: {
        workspaceId, type: "CONVERSATION_ESCALATED", severity: "INFO", title: "Asistan yanıt üretemedi", message: "m",
        entityType: "CONVERSATION", entityId: active.id,
      },
    });
    as("PATIENT_COORDINATOR");
    const takeover = await escalate(req(`/api/conversations/${active.id}/escalate`, "POST", { note: "Ben bakıyorum" }), ctx(active.id));
    expect(takeover.status).toBe(200);
    expect((await takeover.json()).conversation).toMatchObject({ status: "ESCALATED", escalatedTo: users.PATIENT_COORDINATOR, claimed: false });
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("RESOLVED");
    const note = await prisma.message.findFirstOrThrow({ where: { conversationId: active.id, sender: "system" } });
    expect(note.content).toBe("Konuşma Ayşe Koordinatör tarafından devralındı; asistan susturuldu. Not: Ben bakıyorum");
  });
});
