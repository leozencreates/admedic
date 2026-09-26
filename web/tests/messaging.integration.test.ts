import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Role } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";
import { encrypt } from "../app/_lib/encrypt";
import { leadLookupHash } from "../app/_lib/lead-hash";
import { sendMessengerMessage } from "../app/_lib/messenger";
import { loadEnv } from "@admedic/config";
import { getGraphVersion } from "@admedic/meta-api";

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

import { GET as leadsGet, POST as leadsPost } from "../app/api/leads/route";
import { GET as leadGet, PATCH as leadPatch, DELETE as leadDelete } from "../app/api/leads/[id]/route";
import { GET as messagesGet, POST as sendMessage } from "../app/api/leads/[id]/messages/route";
import { POST as escalate } from "../app/api/conversations/[id]/escalate/route";
import { POST as conversationPost } from "../app/api/conversations/[id]/route";

function req(url: string, method: string, bodyObj?: unknown) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("lead CRM and messaging", () => {
  const suffix = randomBytes(8).toString("hex");
  const userIds: string[] = [];
  const tokens: Partial<Record<Role, string>> = {};
  const users: Partial<Record<Role, string>> = {};
  let orgId = "";
  let workspaceId = "";

  const as = (role: Role) => cookieJar.set(SESSION_COOKIE, tokens[role]!);

  beforeAll(async () => {
    const roles: Role[] = ["OWNER", "MEDIA_BUYER", "PATIENT_COORDINATOR", "VIEWER"];
    const org = await prisma.organization.create({
      data: {
        name: "Messaging fixture",
        slug: `msgfix-${suffix}`,
        consentText: "Özel aydınlatma metni",
        workspaces: { create: { name: "Ws", slug: "ws-msg" } },
      },
      include: { workspaces: true },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0].id;
    for (const role of roles) {
      const user = await prisma.user.create({
        data: {
          email: `${role.toLowerCase()}-${suffix}@example.invalid`,
          name: role === "OWNER" ? "Ayşe Koordinatör" : null,
        },
      });
      userIds.push(user.id);
      users[role] = user.id;
      await prisma.membership.create({ data: { orgId, userId: user.id, role } });
      const token = randomBytes(32).toString("hex");
      await prisma.webSession.create({
        data: {
          tokenHash: tokenHash(token),
          userId: user.id,
          workspaceId,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      tokens[role] = token;
    }
    // Messenger gönderimi için bağlı sayfa (mock modda token gerekmez).
    await prisma.metaConnection.create({
      data: { orgId, type: "PAGE", name: "Fixture page", pageId: `page-msg-${suffix}`, status: "CONNECTED" },
    });
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.consentRecord.deleteMany({ where: { workspaceId } });
    await prisma.metaConnection.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createLead(data: Record<string, unknown>) {
    const res = await leadsPost(req("/api/leads", "POST", data));
    expect(res.status).toBe(200);
    return (await res.json()).lead as { id: string; email: string | null; phone: string | null; metadata: Record<string, unknown> };
  }

  it("sends by lead id, creates the conversation and takes it over from the assistant", async () => {
    as("PATIENT_COORDINATOR");
    const lead = await createLead({ firstName: "Lead", lastName: "Id", phone: "+905321000001", channel: "WHATSAPP" });
    // Konuşma yok: pencere de yok → serbest metin reddedilir, şablon geçer.
    const blocked = await sendMessage(req(`/api/leads/${lead.id}/messages`, "POST", { content: "Merhaba" }), ctx(lead.id));
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toContain("pencere");
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(conversation.channel).toBe("WHATSAPP");
    expect(conversation.status).toBe("ACTIVE");
    // Gerçek gelen mesaj penceresi açar; ilk insan gönderimi konuşmayı otomatik devralır.
    await prisma.message.create({
      data: { conversationId: conversation.id, direction: "INCOMING", channel: "WHATSAPP", content: "selam", sender: "external" },
    });
    const sent = await sendMessage(req(`/api/leads/${lead.id}/messages`, "POST", { content: "Hoş geldiniz" }), ctx(lead.id));
    expect(sent.status).toBe(200);
    const data = await sent.json();
    expect(data.conversation).toMatchObject({ id: conversation.id, status: "ESCALATED", takenOver: true });
    expect(data.message.sender).toBe(users.PATIENT_COORDINATOR);
    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(updated.status).toBe("ESCALATED");
    expect(updated.escalatedTo).toBe(users.PATIENT_COORDINATOR);
    expect(updated.firstResponseAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "CONVERSATION_ESCALATED", entityId: conversation.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "MESSAGE_SENT", entityId: conversation.id } })).toBe(1);
    // GET de lead kimliğiyle çözümlenir.
    const listed = await messagesGet(req(`/api/leads/${lead.id}/messages`, "GET"), ctx(lead.id));
    expect(listed.status).toBe(200);
    const listing = await listed.json();
    expect(listing.conversation.id).toBe(conversation.id);
    expect(listing.conversation.messages).toHaveLength(2);
    // Devralınmış konuşmada koordinatör yazmaya devam eder, MEDIA_BUYER yazamaz.
    as("MEDIA_BUYER");
    const denied = await sendMessage(req(`/api/leads/${lead.id}/messages`, "POST", { content: "Ben de" }), ctx(conversation.id));
    expect(denied.status).toBe(403);
    as("PATIENT_COORDINATOR");
    const again = await sendMessage(req(`/api/leads/${lead.id}/messages`, "POST", { content: "Devam" }), ctx(conversation.id));
    expect(again.status).toBe(200);
    expect((await again.json()).conversation.takenOver).toBe(false);
    as("VIEWER");
    expect((await sendMessage(req(`/api/leads/${lead.id}/messages`, "POST", { content: "x" }), ctx(conversation.id))).status).toBe(403);
  });

  it("sends Messenger messages through the mock path without any outbound request", async () => {
    as("OWNER");
    const lead = await prisma.lead.create({
      data: {
        workspaceId, organizationId: orgId, firstName: "Konuk", lastName: "", channel: "MESSENGER", status: "NEW",
        metadata: { source: "messaging", psid: "psid-1", page_id: `page-msg-${suffix}` },
      },
    });
    const conversation = await prisma.conversation.create({
      data: { leadId: lead.id, workspaceId, channel: "MESSENGER", status: "ACTIVE" },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Kanal uyuşmazlığı 422.
    const mismatch = await sendMessage(req(`/api/leads/${lead.id}/messages`, "POST", { content: "x", channel: "WHATSAPP" }), ctx(lead.id));
    expect(mismatch.status).toBe(422);
    // Pencere dışı Messenger gönderimi HUMAN_AGENT etiketiyle (mock) gider.
    const sent = await sendMessage(req(`/api/leads/${lead.id}/messages`, "POST", { content: "Merhaba", channel: "MESSENGER" }), ctx(lead.id));
    expect(sent.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const message = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, direction: "OUTGOING" } });
    expect(message.metadata).toMatchObject({ humanAgentTag: true });
    expect((message.metadata as { messengerResult: { id: string } }).messengerResult.id).toMatch(/^mock_/);
    // SMS henüz yapılandırılmadı.
    const smsLead = await prisma.lead.create({
      data: { workspaceId, organizationId: orgId, firstName: "Sms", lastName: "", channel: "SMS", status: "NEW" },
    });
    const sms = await sendMessage(req(`/api/leads/${smsLead.id}/messages`, "POST", { content: "x" }), ctx(smsLead.id));
    expect(sms.status).toBe(422);
  });

  it("calls the Meta Send API with a bearer page token when mock mode is off", async () => {
    const pageId = `page-real-${suffix}`;
    await prisma.metaConnection.create({
      data: { orgId, type: "PAGE", name: "Real page", pageId, status: "CONNECTED", tokenCiphertext: encrypt("page-token-secret") },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ recipient_id: "psid-2", message_id: "mid-out-1" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "This message is sent outside of allowed window.", code: 10, error_subcode: 2018278 } }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "false" } });
    try {
      const ok = await sendMessengerMessage({ orgId, channel: "MESSENGER", psid: "psid-2", pageId, text: "Merhaba" });
      expect(ok).toEqual({ id: "mid-out-1", error: null, humanAgentTag: false });
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://graph.facebook.com/${getGraphVersion()}/${pageId}/messages`);
      expect(url).not.toContain("access_token");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer page-token-secret");
      expect(JSON.parse(String(init.body))).toEqual({
        recipient: { id: "psid-2" }, messaging_type: "RESPONSE", message: { text: "Merhaba" },
      });
      const outside = await sendMessengerMessage({ orgId, channel: "MESSENGER", psid: "psid-2", pageId, text: "Geç", humanAgent: true });
      expect(outside.error).toContain("Human Agent");
      const [, tagged] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(JSON.parse(String(tagged.body))).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
      // Bağlantısı olmayan sayfa / PSID'siz lead için dış istek yapılmaz.
      expect((await sendMessengerMessage({ orgId, channel: "MESSENGER", psid: null, pageId, text: "x" })).error).toContain("psid");
      expect((await sendMessengerMessage({ orgId, channel: "MESSENGER", psid: "p", pageId: "unknown-page", text: "x" })).error).toContain("bağlantı");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      loadEnv({ fresh: true });
    }
  });

  it("opens the 24h window only for real inbound messages", async () => {
    as("OWNER");
    const mk = async () => {
      const lead = await prisma.lead.create({
        data: { workspaceId, organizationId: orgId, firstName: "Win", lastName: "", phone: encrypt("+905321000009"), channel: "WHATSAPP", status: "NEW" },
      });
      const conversation = await prisma.conversation.create({
        data: { leadId: lead.id, workspaceId, channel: "WHATSAPP", status: "ACTIVE" },
      });
      return conversation.id;
    };
    const send = (id: string) => sendMessage(req(`/api/leads/${id}/messages`, "POST", { content: "Merhaba" }), ctx(id));

    const simulated = await mk();
    // Panelden simüle edilen gelen mesaj (sender = kullanıcı kimliği, dış kimlik yok) pencere açmaz.
    await prisma.message.create({
      data: { conversationId: simulated, direction: "INCOMING", channel: "WHATSAPP", content: "test", sender: users.OWNER },
    });
    expect((await send(simulated)).status).toBe(400);
    // Eski (pencere dışı) gerçek mesaj da açmaz.
    await prisma.message.create({
      data: {
        conversationId: simulated, direction: "INCOMING", channel: "WHATSAPP", content: "eski", sender: "external",
        createdAt: new Date(Date.now() - 25 * 3600 * 1000),
      },
    });
    expect((await send(simulated)).status).toBe(400);
    // metadata.mid dolu gerçek gelen mesaj pencereyi açar.
    await prisma.message.create({
      data: { conversationId: simulated, direction: "INCOMING", channel: "WHATSAPP", content: "gerçek", sender: "psid-9", metadata: { mid: `m-${suffix}` } },
    });
    expect((await send(simulated)).status).toBe(200);

    const byExternalId = await mk();
    await prisma.message.create({
      data: { conversationId: byExternalId, direction: "INCOMING", channel: "WHATSAPP", content: "wamid", sender: "psid-9", externalId: `wamid-${suffix}` },
    });
    expect((await send(byExternalId)).status).toBe(200);
  });

  it("normalizes template names and rejects invalid ones", async () => {
    as("OWNER");
    const lead = await prisma.lead.create({
      data: { workspaceId, organizationId: orgId, firstName: "Tpl", lastName: "", phone: encrypt("+905321000010"), channel: "WHATSAPP", status: "NEW", language: "AR" },
    });
    const conversation = await prisma.conversation.create({
      data: { leadId: lead.id, workspaceId, channel: "WHATSAPP", status: "ACTIVE" },
    });
    const bad = await sendMessage(req(`/api/leads/${lead.id}/messages`, "POST", { templateName: "bad name" }), ctx(conversation.id));
    expect(bad.status).toBe(422);
    const ok = await sendMessage(
      req(`/api/leads/${lead.id}/messages`, "POST", { templateName: "Hosgeldiniz_TR", templateParams: { "1": "Ada" } }),
      ctx(conversation.id),
    );
    expect(ok.status).toBe(200);
    const message = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id } });
    expect(message.metadata).toMatchObject({ whatsappTemplate: "hosgeldiniz_tr", whatsappTemplateParams: { "1": "Ada" } });
    expect(message.content).toContain("hosgeldiniz_tr");
    // Şablon yalnızca WhatsApp'ta.
    const igLead = await prisma.lead.create({
      data: { workspaceId, organizationId: orgId, firstName: "Ig", lastName: "", channel: "INSTAGRAM", status: "NEW", metadata: { psid: "ig-1" } },
    });
    const igConv = await prisma.conversation.create({ data: { leadId: igLead.id, workspaceId, channel: "INSTAGRAM", status: "ACTIVE" } });
    expect(
      (await sendMessage(req(`/api/leads/${igLead.id}/messages`, "POST", { templateName: "welcome", channel: "INSTAGRAM" }), ctx(igConv.id))).status,
    ).toBe(422);
  });

  it("writes the escalation note with the actor's display name and audits conversation writes", async () => {
    as("OWNER");
    const lead = await prisma.lead.create({
      data: { workspaceId, organizationId: orgId, firstName: "Esc", lastName: "", channel: "WHATSAPP", status: "NEW" },
    });
    as("VIEWER");
    expect((await conversationPost(req(`/api/conversations/${lead.id}`, "POST", { channel: "WHATSAPP" }), ctx(lead.id))).status).toBe(403);
    as("PATIENT_COORDINATOR");
    const created = await conversationPost(req(`/api/conversations/${lead.id}`, "POST", { channel: "WHATSAPP" }), ctx(lead.id));
    expect(created.status).toBe(200);
    const conversationId = (await created.json()).conversation.id as string;
    expect(await prisma.auditLog.count({ where: { action: "CONVERSATION_CREATED", entityId: conversationId } })).toBe(1);
    as("OWNER");
    const res = await escalate(req(`/api/conversations/${conversationId}/escalate`, "POST", { note: "Acil" }), ctx(conversationId));
    expect(res.status).toBe(200);
    const note = await prisma.message.findFirstOrThrow({ where: { conversationId, sender: "system" } });
    expect(note.content).toContain("Ayşe Koordinatör");
    expect(note.content).not.toContain(users.OWNER!);
    expect(note.content).toContain("Acil");
    expect(await prisma.auditLog.count({ where: { action: "CONVERSATION_ESCALATED", entityId: conversationId } })).toBe(1);
  });

  it("enforces lostReason rules on PATCH", async () => {
    as("PATIENT_COORDINATOR");
    const lead = await createLead({ firstName: "Lost", lastName: "Case", phone: "+905321000002" });
    const patch = (payload: unknown) => leadPatch(req(`/api/leads/${lead.id}`, "PATCH", payload), ctx(lead.id));
    expect((await patch({ lostReason: "erken" })).status).toBe(422);
    expect((await patch({ status: "LOST" })).status).toBe(422);
    expect((await patch({ status: "LOST", lostReason: "   " })).status).toBe(422);
    expect((await patch({ status: "LOST", lostReason: " Bütçe yetersiz " })).status).toBe(200);
    const lost = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(lost.status).toBe("LOST");
    expect(lost.lostReason).toBe("Bütçe yetersiz");
    expect(lost.lostAt).not.toBeNull();
    expect((await patch({ lostReason: null })).status).toBe(422);
    expect((await patch({ lostReason: "Başka klinik" })).status).toBe(200);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).lostReason).toBe("Başka klinik");
  });

  it("records, withdraws and re-grants consent with the organisation text", async () => {
    as("PATIENT_COORDINATOR");
    const lead = await createLead({ firstName: "Consent", lastName: "Case", email: "consent@example.invalid" });
    const patch = (payload: unknown) => leadPatch(req(`/api/leads/${lead.id}`, "PATCH", payload), ctx(lead.id));
    expect((await patch({ consentGiven: true })).status).toBe(200);
    let records = await prisma.consentRecord.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: "asc" } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "GRANTED", consentText: "Özel aydınlatma metni", type: "MARKETING" });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).consentGiven).toBe(true);
    // Tekrar true: yeni kayıt açılmaz.
    expect((await patch({ consentGiven: true })).status).toBe(200);
    expect(await prisma.consentRecord.count({ where: { leadId: lead.id } })).toBe(1);
    expect((await patch({ consentGiven: false })).status).toBe(200);
    records = await prisma.consentRecord.findMany({ where: { leadId: lead.id } });
    expect(records[0].status).toBe("WITHDRAWN");
    expect(records[0].withdrawnAt).not.toBeNull();
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).consentGiven).toBe(false);
    expect((await patch({ consentGiven: true })).status).toBe(200);
    expect(await prisma.consentRecord.count({ where: { leadId: lead.id, status: "GRANTED" } })).toBe(1);
    expect(await prisma.consentRecord.count({ where: { leadId: lead.id } })).toBe(2);
  });

  it("merges metadata without touching idempotency keys", async () => {
    as("OWNER");
    const lead = await createLead({
      firstName: "Meta", lastName: "Case", phone: "+905321000003",
      metadata: { leadgen_id: "lg-keep", source: "lead_ads", page_id: "p-1", note: "a" },
    });
    const patched = await leadPatch(
      req(`/api/leads/${lead.id}`, "PATCH", { metadata: { leadgen_id: "hack", source: null, note: "b", extra: 1 } }),
      ctx(lead.id),
    );
    expect(patched.status).toBe(200);
    const stored = (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).metadata;
    expect(stored).toEqual({ leadgen_id: "lg-keep", source: "lead_ads", page_id: "p-1", note: "b", extra: 1 });
    await leadPatch(req(`/api/leads/${lead.id}`, "PATCH", { metadata: { note: null } }), ctx(lead.id));
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).metadata).toEqual({
      leadgen_id: "lg-keep", source: "lead_ads", page_id: "p-1", extra: 1,
    });
  });

  it("recomputes the lookup hash on contact change and rejects duplicates", async () => {
    as("OWNER");
    const a = await createLead({ firstName: "Hash", lastName: "A", phone: "+90 532 111 22 33", email: "a@example.invalid" });
    // Aynı numara yerel yazımla ve farklı e-postayla da aynı kişidir.
    const dup = await leadsPost(req("/api/leads", "POST", { firstName: "Hash", lastName: "Dup", phone: "0532 111 22 33", email: "other@example.invalid" }));
    expect(dup.status).toBe(409);
    const b = await createLead({ firstName: "Hash", lastName: "B", phone: "+905550000000" });
    const clash = await leadPatch(req(`/api/leads/${b.id}`, "PATCH", { phone: "0532 111 22 33" }), ctx(b.id));
    expect(clash.status).toBe(409);
    const moved = await leadPatch(req(`/api/leads/${b.id}`, "PATCH", { phone: "+905550000001" }), ctx(b.id));
    expect(moved.status).toBe(200);
    const stored = await prisma.lead.findUniqueOrThrow({ where: { id: b.id } });
    expect(stored.lookupHash).toBe(leadLookupHash({ orgId, phone: "+905550000001" }));
    expect(stored.lookupHash).not.toBe(leadLookupHash({ orgId, phone: "+905550000000" }));
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: a.id } })).lookupHash).toBe(
      leadLookupHash({ orgId, phone: "0532 111 22 33" }),
    );
  });

  it("masks contact data for VIEWER, strips lookupHash and PII-like metadata keys", async () => {
    as("OWNER");
    const created = await createLead({
      firstName: "Mask", lastName: "Case", phone: "+905321000004", email: "guest@example.invalid",
      metadata: { source: "lead_ads", form_name: "Dental", fields: { email: "guest@example.invalid", phone_number: "+905321000004", first_name: "Ada", treatment: "implant" } },
    });
    expect(created.email).toBe("guest@example.invalid");
    expect(created.metadata).toEqual({ source: "lead_ads", form_name: "Dental", fields: { treatment: "implant" } });
    expect("lookupHash" in created).toBe(false);
    const ownerView = await (await leadGet(req(`/api/leads/${created.id}`, "GET"), ctx(created.id))).json();
    expect(ownerView.lead.phone).toBe("+905321000004");
    expect(ownerView.lead.lookupHash).toBeUndefined();
    as("VIEWER");
    const detail = await leadGet(req(`/api/leads/${created.id}`, "GET"), ctx(created.id));
    expect(detail.status).toBe(200);
    const viewerLead = (await detail.json()).lead;
    expect(viewerLead.email).toBe("g***@example.invalid");
    expect(viewerLead.phone).toBe("+90***04");
    expect(viewerLead.lookupHash).toBeUndefined();
    expect(viewerLead.metadata.fields).toEqual({ treatment: "implant" });
    const list = await (await leadsGet()).json();
    const row = list.leads.find((l: { id: string }) => l.id === created.id);
    expect(row).toMatchObject({ email: "g***@example.invalid", phone: "+90***04", campaignId: null });
    expect(row.lookupHash).toBeUndefined();
    expect(row.metadata.fields).toEqual({ treatment: "implant" });
    // VIEWER lead durumunu değiştiremez; koordinatör değiştirebilir.
    expect((await leadPatch(req(`/api/leads/${created.id}`, "PATCH", { status: "CONTACTED" }), ctx(created.id))).status).toBe(403);
    as("PATIENT_COORDINATOR");
    expect((await leadPatch(req(`/api/leads/${created.id}`, "PATCH", { status: "CONTACTED" }), ctx(created.id))).status).toBe(200);
  });

  it("deletes by anonymizing, owner/admin only", async () => {
    as("OWNER");
    const lead = await createLead({ firstName: "Del", lastName: "Case", phone: "+905321000005", metadata: { note: "x" } });
    const conversation = await prisma.conversation.create({ data: { leadId: lead.id, workspaceId, channel: "WHATSAPP", status: "ACTIVE" } });
    await prisma.message.create({ data: { conversationId: conversation.id, direction: "INCOMING", channel: "WHATSAPP", content: "gizli", sender: "external" } });
    as("MEDIA_BUYER");
    expect((await leadDelete(req(`/api/leads/${lead.id}`, "DELETE"), ctx(lead.id))).status).toBe(403);
    as("PATIENT_COORDINATOR");
    expect((await leadDelete(req(`/api/leads/${lead.id}`, "DELETE"), ctx(lead.id))).status).toBe(403);
    as("OWNER");
    const res = await leadDelete(req(`/api/leads/${lead.id}`, "DELETE"), ctx(lead.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, anonymized: true });
    const stored = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { conversations: { include: { messages: true } } } });
    expect(stored.firstName).toBe("[anonymized]");
    expect(stored.phone).toBeNull();
    expect(stored.lookupHash).toBeNull();
    expect(stored.metadata).toEqual({ anonymized: true });
    expect(stored.conversations[0].status).toBe("CLOSED");
    expect(stored.conversations[0].messages[0].content).toBe("[anonymized]");
    expect(await prisma.auditLog.count({ where: { entityId: lead.id, action: { in: ["LEAD_DELETED", "PRIVACY_ANONYMIZE"] } } })).toBe(2);
    expect((await leadDelete(req(`/api/leads/${randomBytes(6).toString("hex")}`, "DELETE"), ctx("missing"))).status).toBe(404);
  });
});
