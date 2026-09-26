import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { HANDOFF_NOTICE } from "@admedic/llm";
import { SESSION_COOKIE, type Actor } from "../app/_lib/auth";
import { tokenHash, hashPassword } from "../app/_lib/password";
import { encrypt } from "../app/_lib/encrypt";
import { BOT_DISCLOSURE } from "../app/_lib/webhook-ingest";
import { respondToInbound, toHistory, HANDOFF_ALERT_TYPE } from "../app/_lib/lead-assistant";
import { POST as aiChat } from "../app/api/ai/chat/route";

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

const LEAD_PHONE = "+905551234567";
const LEAD_EMAIL = "assistant-lead@example.invalid";

function request(body: unknown) {
  return new Request("http://localhost:3000/api/ai/chat", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const llmResponse = (text: string, input = 40, output = 12) =>
  Response.json({
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: input, output_tokens: output },
  });

describe("lead assistant pure helpers", () => {
  it("maps conversation rows to chronological history and skips system notes", () => {
    const history = toHistory([
      { direction: "OUTGOING", sender: "system", content: "⚠ devralındı" },
      { direction: "INCOMING", sender: "external", content: "ikinci" },
      { direction: "OUTGOING", sender: "bot", content: "karşılama" },
      { direction: "INCOMING", sender: "external", content: "ilk" },
    ]);
    expect(history).toEqual([
      { role: "lead", text: "ilk" },
      { role: "assistant", text: "karşılama" },
      { role: "lead", text: "ikinci" },
    ]);
  });
});

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("AI lead assistant (respondToInbound + /api/ai/chat)", () => {
  const suffix = randomBytes(8).toString("hex");
  const password = randomBytes(24).toString("hex");
  const email = `assistant-${suffix}@example.invalid`;
  const token = randomBytes(32).toString("hex");
  let owner: Actor;
  let userId = "";
  let leadId = "";
  let conversationId = "";
  let foreignOrgId = "";
  let foreignConversationId = "";

  beforeAll(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-placeholder");
    vi.stubEnv("LLM_MODEL", "test-model");
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password) } });
    userId = user.id;
    const org = await prisma.organization.create({
      data: {
        name: "Assistant fixture",
        slug: `assist-${suffix}`,
        consentText: "Kişisel verileriniz KVKK kapsamında işlenir.",
        members: { create: { userId, role: "OWNER" } },
        workspaces: { create: { name: "Assistant", slug: "assist" } },
      },
      include: { workspaces: true },
    });
    const workspaceId = org.workspaces[0]!.id;
    owner = { userId, orgId: org.id, workspaceId, role: "OWNER", workspaceName: "Assistant" };
    await prisma.clinicProfile.create({
      data: {
        workspaceId,
        name: "Fixture Klinik",
        slug: `fixture-${suffix}`,
        languages: ["DE", "EN"],
        brandTone: "Sakin ve net",
        services: { create: [{ name: "Haartransplantation", slug: "haartransplantation", category: "SURGICAL" }] },
      },
    });
    const lead = await prisma.lead.create({
      data: {
        workspaceId,
        organizationId: org.id,
        firstName: "Max",
        lastName: "Mustermann",
        phone: encrypt(LEAD_PHONE),
        email: encrypt(LEAD_EMAIL),
        language: "de",
        channel: "WHATSAPP",
        status: "NEW",
      },
    });
    leadId = lead.id;
    const conversation = await prisma.conversation.create({
      data: { leadId, workspaceId, channel: "WHATSAPP", status: "ACTIVE", firstResponseAt: new Date(), initiatedBy: "bot" },
    });
    conversationId = conversation.id;
    await prisma.message.create({
      data: { conversationId, direction: "INCOMING", channel: "WHATSAPP", content: "Hallo", sender: "external", externalId: `wamid_${suffix}_1` },
    });
    await prisma.message.create({
      data: { conversationId, direction: "OUTGOING", channel: "WHATSAPP", content: `Willkommen!\n\n${BOT_DISCLOSURE.de}`, sender: "bot", metadata: { autoGreet: true } },
    });
    await prisma.webSession.create({
      data: { tokenHash: tokenHash(token), userId, workspaceId, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set(SESSION_COOKIE, token);
    // Yabancı tenant: aynı kullanıcı üye değil; konuşması 404 olmalı.
    const foreign = await prisma.organization.create({
      data: { name: "Foreign", slug: `assist-foreign-${suffix}`, workspaces: { create: { name: "F", slug: "f" } } },
      include: { workspaces: true },
    });
    foreignOrgId = foreign.id;
    const foreignLead = await prisma.lead.create({
      data: { workspaceId: foreign.workspaces[0]!.id, organizationId: foreign.id, firstName: "F", lastName: "L", language: "tr", channel: "WHATSAPP" },
    });
    const foreignConversation = await prisma.conversation.create({
      data: { leadId: foreignLead.id, workspaceId: foreign.workspaces[0]!.id, channel: "WHATSAPP", status: "ACTIVE" },
    });
    foreignConversationId = foreignConversation.id;
    await prisma.message.create({
      data: { conversationId: foreignConversationId, direction: "INCOMING", channel: "WHATSAPP", content: "selam", sender: "external" },
    });
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.organization.deleteMany({ where: { id: { in: [owner.orgId, foreignOrgId] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replies to the last inbound message via the lead-assistant prompt, sends it and logs real usage without PII", async () => {
    await prisma.message.create({
      data: { conversationId, direction: "INCOMING", channel: "WHATSAPP", content: `Ich interessiere mich für Haartransplantation, meine Mail: ${LEAD_EMAIL}`, sender: "external", externalId: `wamid_${suffix}_2` },
    });
    const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(llmResponse("Gerne! Aus welchem Land schreiben Sie uns?"));
    const result = await respondToInbound(conversationId, { workspaceId: owner.workspaceId, actorUserId: owner.userId });
    expect(result).toMatchObject({ conversationId, escalated: false, reason: null, delivered: true });
    expect(result.reply).toBe("Gerne! Aus welchem Land schreiben Sie uns?"); // karşılama zaten gitti: açıklama satırı tekrarlanmaz
    const outgoing = await prisma.message.findUniqueOrThrow({ where: { id: result.messageId } });
    expect(outgoing).toMatchObject({ direction: "OUTGOING", sender: "ai", channel: "WHATSAPP", content: result.reply });
    const meta = outgoing.metadata as Record<string, unknown>;
    expect(meta.autoReply).toBe(true);
    expect(meta.pendingSend).toBe(false);
    expect((meta.providerResult as Record<string, unknown>).id).toMatch(/^mock_/);
    // Prompt: takma kimlik var, DB anahtarı / ad / telefon / e-posta yok; e-posta maskelendi; geçmiş dahil.
    expect(transport).toHaveBeenCalledTimes(1);
    const req = JSON.parse(String(transport.mock.calls[0]![1]?.body));
    expect(req.model).toBe("test-model");
    expect(req.system).toMatch(/Lead takma kimliği: [0-9a-f]{8}/);
    expect(req.system).toContain("Fixture Klinik");
    expect(req.system).toContain("Haartransplantation");
    expect(req.system).toContain("KVKK");
    expect(req.system).not.toContain("otomatik bir asistan olduğunu açıkça belirt");
    const raw = JSON.stringify(req);
    for (const secret of [leadId, LEAD_PHONE, LEAD_EMAIL, "Mustermann"]) expect(raw).not.toContain(secret);
    expect(req.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(req.messages[2].content).toContain("[e-posta]");
    const log = await prisma.llmCallLog.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, agent: "lead-assistant" } });
    expect(log).toMatchObject({ promptVersion: "lead-assistant-v1", status: "COMPLETED", inputTokens: 40, outputTokens: 12, model: "test-model" });
    // Son mesaj artık OUTGOING: yeniden çağrı 409, LLM çağrılmaz.
    await expect(respondToInbound(conversationId, { workspaceId: owner.workspaceId })).rejects.toMatchObject({ status: 409 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("escalates on emergency keywords via /api/ai/chat: notice in the lead's language, alert, audit, no LLM call", async () => {
    const transport = vi.spyOn(globalThis, "fetch");
    const res = await aiChat(request({ leadId, message: "Es ist dringend, ich kann nicht atmen" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ conversationId, escalated: true, reason: "emergency", delivered: true });
    expect(data.messages[1]).toBe(HANDOFF_NOTICE.DE.emergency);
    expect(transport).not.toHaveBeenCalled();
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.status).toBe("ESCALATED");
    expect(conversation.escalatedTo).toBe(owner.userId);
    const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
    const simulated = messages.at(-2)!;
    expect(simulated).toMatchObject({ direction: "INCOMING", sender: "simulated" });
    expect((simulated.metadata as Record<string, unknown>).simulated).toBe(true);
    expect(messages.at(-1)).toMatchObject({ direction: "OUTGOING", sender: "ai", content: HANDOFF_NOTICE.DE.emergency });
    const alert = await prisma.alert.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, entityId: conversationId } });
    expect(alert).toMatchObject({ type: HANDOFF_ALERT_TYPE, severity: "CRITICAL", entityType: "CONVERSATION", status: "OPEN" });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: conversationId, action: "CONVERSATION_ESCALATED" } });
    expect(audit.after).toMatchObject({ status: "ESCALATED", auto: true, by: "assistant", reason: "emergency" });
    // Devralınmış konuşmada asistan susar: 409.
    const again = await aiChat(request({ leadId, message: "Hallo?" }));
    expect(again.status).toBe(409);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(messages.length);
  });

  it("creates a conversation for a first contact, adds the bot disclosure once and hands off price questions with an INFO alert", async () => {
    const lead = await prisma.lead.create({
      data: { workspaceId: owner.workspaceId, organizationId: owner.orgId, firstName: "Neu", lastName: "Kontakt", phone: encrypt("+4915112345678"), language: "de", channel: "WHATSAPP" },
    });
    const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(llmResponse("Vielen Dank für Ihre Nachricht! Für welche Behandlung interessieren Sie sich?"));
    const res = await aiChat(request({ leadId: lead.id, message: "Hallo, ich möchte Informationen" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.escalated).toBe(false);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[1]).toContain("Vielen Dank für Ihre Nachricht!");
    expect(data.messages[1]).toContain(BOT_DISCLOSURE.de); // ilk bot mesajı: otomatik asistan satırı
    const req = JSON.parse(String(transport.mock.calls[0]![1]?.body));
    expect(req.system).toContain("otomatik bir asistan olduğunu açıkça belirt");
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(conversation.status).toBe("ACTIVE");
    expect(conversation.firstResponseAt).not.toBeNull();
    // İkinci tur: açıklama satırı tekrarlanmaz; mesaj verilmezse son gelen mesaja yanıt üretilir.
    await prisma.message.create({
      data: { conversationId: conversation.id, direction: "INCOMING", channel: "WHATSAPP", content: "Haartransplantation", sender: "external", externalId: `wamid_${suffix}_3` },
    });
    transport.mockResolvedValue(llmResponse("Verstanden. Wann dürfen wir Sie anrufen?"));
    const second = await aiChat(request({ leadId: lead.id }));
    expect(second.status).toBe(200);
    const secondData = await second.json();
    expect(secondData.messages).toEqual(["Verstanden. Wann dürfen wir Sie anrufen?"]);
    expect(JSON.parse(String(transport.mock.calls[1]![1]?.body)).system).not.toContain("otomatik bir asistan olduğunu açıkça belirt");
    // Yanıtlanacak yeni mesaj yoksa 409.
    expect((await aiChat(request({ leadId: lead.id }))).status).toBe(409);
    // Kapsam dışı (fiyat): devir + INFO uyarısı, LLM çağrılmaz.
    const calls = transport.mock.calls.length;
    const price = await aiChat(request({ leadId: lead.id, message: "Was kostet die Behandlung?" }));
    expect(price.status).toBe(200);
    expect(await price.json()).toMatchObject({ escalated: true, reason: "out_of_scope" });
    expect(transport.mock.calls.length).toBe(calls);
    const alert = await prisma.alert.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, entityId: conversation.id } });
    expect(alert.severity).toBe("INFO");
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("ESCALATED");
  });

  it("fails closed without LLM configuration (503) and isolates tenants (404)", async () => {
    const lead = await prisma.lead.create({
      data: { workspaceId: owner.workspaceId, organizationId: owner.orgId, firstName: "Ohne", lastName: "Key", language: "en", channel: "WHATSAPP" },
    });
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("LLM_MODEL", "");
    try {
      const res = await aiChat(request({ leadId: lead.id, message: "Hello, I need information" }));
      expect(res.status).toBe(503);
      // Devir tespiti LLM olmadan da çalışır.
      const urgent = await aiChat(request({ leadId: lead.id, message: "urgent" }));
      expect(urgent.status).toBe(200);
      expect(await urgent.json()).toMatchObject({ escalated: true, reason: "emergency" });
    } finally {
      vi.stubEnv("ANTHROPIC_API_KEY", "test-placeholder");
      vi.stubEnv("LLM_MODEL", "test-model");
    }
    await expect(respondToInbound(foreignConversationId, { workspaceId: owner.workspaceId })).rejects.toMatchObject({ status: 404 });
    expect((await aiChat(request({ leadId: "nope", message: "x" }))).status).toBe(404);
    expect((await aiChat(request({ leadId, conversationId: foreignConversationId, message: "x" }))).status).toBe(404);
  });
});
