import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { encryptField, loadEnv } from "@admedic/config";
import { HANDOFF_NOTICE } from "@admedic/llm";
import type { sendWhatsAppMessage } from "@admedic/meta-api";
import { ASSISTANT_MAX_ATTEMPTS, HANDOFF_ALERT_TYPE, runAssistant, toHistory } from "./assistant";

const LEAD_PHONE = "+4915112345678";
const llm = { apiKey: "test-placeholder", model: "test-model" };
const llmResponse = (text: string) =>
  Response.json({
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 33, output_tokens: 11 },
  });

describe("assistant saf yardımcıları", () => {
  it("geçmişi kronolojik role çevirir", () => {
    expect(
      toHistory([
        { direction: "INCOMING", sender: "external", content: "b" },
        { direction: "OUTGOING", sender: "system", content: "not" },
        { direction: "OUTGOING", sender: "ai", content: "cevap" },
        { direction: "INCOMING", sender: "external", content: "a" },
      ]),
    ).toEqual([
      { role: "lead", text: "a" },
      { role: "assistant", text: "cevap" },
      { role: "lead", text: "b" },
    ]);
  });
});

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("assistant worker (DB)", () => {
  const suffix = randomBytes(6).toString("hex");
  let orgId = "";
  let workspaceId = "";
  let leadId = "";
  let activeId = "";
  let escalatedId = "";
  const past = new Date(Date.now() - 60_000);

  async function conversation(status: "ACTIVE" | "ESCALATED", inbound: string, channel: "WHATSAPP" | "MESSENGER" = "WHATSAPP") {
    const c = await prisma.conversation.create({
      data: { leadId, workspaceId, channel, status, firstResponseAt: past, initiatedBy: "bot" },
    });
    await prisma.message.create({
      data: { conversationId: c.id, direction: "INCOMING", channel, content: "Hallo", sender: "external", createdAt: new Date(past.getTime() - 5_000) },
    });
    await prisma.message.create({
      data: { conversationId: c.id, direction: "OUTGOING", channel, content: "Willkommen (bot)", sender: "bot", createdAt: new Date(past.getTime() - 1_000), metadata: { autoGreet: true } },
    });
    await prisma.message.create({
      data: { conversationId: c.id, direction: "INCOMING", channel, content: inbound, sender: "external" },
    });
    return c.id;
  }
  const outgoing = (conversationId: string) =>
    prisma.message.findMany({ where: { conversationId, direction: "OUTGOING" }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "true" } });
    const org = await prisma.organization.create({
      data: {
        name: "Assistant worker fixture",
        slug: `assist-worker-${suffix}`,
        consentText: "Aydınlatma metni",
        workspaces: { create: { name: "W", slug: "w" } },
      },
      include: { workspaces: true },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0]!.id;
    await prisma.clinicProfile.create({
      data: { workspaceId, name: "Worker Klinik", slug: `worker-${suffix}`, languages: ["DE"] },
    });
    const lead = await prisma.lead.create({
      data: {
        workspaceId,
        organizationId: orgId,
        firstName: "Erika",
        lastName: "Musterfrau",
        phone: encryptField(LEAD_PHONE),
        language: "de",
        channel: "WHATSAPP",
      },
    });
    leadId = lead.id;
    activeId = await conversation("ACTIVE", "Ich interessiere mich für eine Haartransplantation.");
    escalatedId = await conversation("ESCALATED", "Hallo, noch jemand da?");
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: orgId } });
    vi.unstubAllEnvs();
    loadEnv({ fresh: true });
    await prisma.$disconnect();
  });

  it("ACTIVE konuşmadaki yanıtlanmamış gelen mesaja OUTGOING üretir ve gönderir; ESCALATED'a dokunmaz", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(llmResponse("Gerne! Aus welchem Land schreiben Sie uns?"));
    const whatsapp = vi.fn<typeof sendWhatsAppMessage>(async () => ({ id: "wamid.mock", error: null }));
    const result = await runAssistant({ llm, transport, senders: { whatsapp }, workspaceId });
    expect(result).toMatchObject({ replied: 1, escalated: 0, failed: 0 });
    const replies = await outgoing(activeId);
    expect(replies).toHaveLength(2);
    expect(replies[1]).toMatchObject({ sender: "ai", content: "Gerne! Aus welchem Land schreiben Sie uns?" });
    const meta = replies[1]!.metadata as Record<string, unknown>;
    expect(meta.pendingSend).toBe(false);
    expect((meta.providerResult as Record<string, unknown>).id).toBe("wamid.mock");
    expect(whatsapp).toHaveBeenCalledTimes(1);
    expect(whatsapp.mock.calls[0]![0]).toEqual({ phone: LEAD_PHONE, language: "de", transport: null });
    // ESCALATED konuşma: bot susar.
    expect(await outgoing(escalatedId)).toHaveLength(1);
    // Prompt: takma kimlik var, telefon/ad/DB anahtarı yok; geçmiş dahil; günlük gerçek token ile.
    const req = JSON.parse(String(transport.mock.calls[0]![1]?.body));
    expect(req.model).toBe("test-model");
    expect(req.system).toMatch(/Lead takma kimliği: [0-9a-f]{8}/);
    expect(req.system).toContain("Worker Klinik");
    const raw = JSON.stringify(req);
    for (const secret of [leadId, LEAD_PHONE, "Musterfrau"]) expect(raw).not.toContain(secret);
    expect(req.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    const log = await prisma.llmCallLog.findFirstOrThrow({ where: { workspaceId, agent: "lead-assistant" } });
    expect(log).toMatchObject({ promptVersion: "lead-assistant-v1", status: "COMPLETED", inputTokens: 33, outputTokens: 11 });
    // İkinci tur: son mesaj OUTGOING → aday yok, LLM çağrılmaz.
    expect(await runAssistant({ llm, transport, senders: { whatsapp }, workspaceId })).toMatchObject({ replied: 0, escalated: 0 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("acil kelimede LLM çağırmadan devreder: ESCALATED + lead bilgilendirmesi + CRITICAL uyarı + audit", async () => {
    const urgentId = await conversation("ACTIVE", "Es ist dringend, ich habe starke Blutung");
    const transport = vi.fn<typeof fetch>();
    const whatsapp = vi.fn(async () => ({ id: "wamid.mock2", error: null }));
    const result = await runAssistant({ llm, transport, senders: { whatsapp }, workspaceId });
    expect(result).toMatchObject({ replied: 0, escalated: 1 });
    expect(transport).not.toHaveBeenCalled();
    const c = await prisma.conversation.findUniqueOrThrow({ where: { id: urgentId } });
    expect(c.status).toBe("ESCALATED");
    const replies = await outgoing(urgentId);
    expect(replies.at(-1)).toMatchObject({ sender: "ai", content: HANDOFF_NOTICE.DE.emergency });
    expect(whatsapp).toHaveBeenCalledWith({ phone: LEAD_PHONE, language: "de", transport: null }, HANDOFF_NOTICE.DE.emergency);
    const alert = await prisma.alert.findFirstOrThrow({ where: { workspaceId, entityId: urgentId } });
    expect(alert).toMatchObject({ type: HANDOFF_ALERT_TYPE, severity: "CRITICAL", entityType: "CONVERSATION" });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: urgentId, action: "CONVERSATION_ESCALATED" } });
    expect(audit.userId).toBeNull();
    expect(audit.after).toMatchObject({ auto: true, by: "assistant", reason: "emergency" });
  });

  it("LLM hatasında deneme sayar, sınırda koordinatör uyarısı açar; LLM yoksa yalnızca devir çalışır", async () => {
    const flakyId = await conversation("ACTIVE", "Können Sie mir mehr erzählen?");
    const failing = vi.fn<typeof fetch>().mockResolvedValue(new Response("boom", { status: 500 }));
    const whatsapp = vi.fn(async () => ({ id: "x", error: null }));
    for (let attempt = 1; attempt <= ASSISTANT_MAX_ATTEMPTS; attempt++) {
      expect(await runAssistant({ llm, transport: failing, senders: { whatsapp }, workspaceId })).toMatchObject({ failed: 1 });
      const inbound = await prisma.message.findFirstOrThrow({ where: { conversationId: flakyId, direction: "INCOMING" }, orderBy: { createdAt: "desc" } });
      expect((inbound.metadata as Record<string, unknown>).assistantAttempts).toBe(attempt);
    }
    expect(await prisma.alert.count({ where: { workspaceId, entityId: flakyId, title: "Asistan yanıt üretemedi" } })).toBe(1);
    // Sınır aşıldı: aday değil, tekrar denenmez.
    expect(await runAssistant({ llm, transport: failing, senders: { whatsapp }, workspaceId })).toMatchObject({ failed: 0, replied: 0 });
    expect(await outgoing(flakyId)).toHaveLength(1);
    expect(await prisma.llmCallLog.count({ where: { workspaceId, agent: "lead-assistant", status: "FAILED" } })).toBe(ASSISTANT_MAX_ATTEMPTS);
    expect(whatsapp).not.toHaveBeenCalled();
    // LLM yapılandırılmamış: normal mesaj atlanır, acil mesaj yine devredilir.
    const plainId = await conversation("ACTIVE", "Guten Tag");
    const urgentId = await conversation("ACTIVE", "срочно");
    const result = await runAssistant({ llm: null, senders: { whatsapp }, workspaceId });
    expect(result).toMatchObject({ skipped: 1, escalated: 1, replied: 0 });
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: plainId } })).status).toBe("ACTIVE");
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: urgentId } })).status).toBe("ESCALATED");
    expect(await outgoing(plainId)).toHaveLength(1);
  });

  it("24 saatlik pencere dışındaki gelen mesaja yanıt üretmez (koordinatöre bırakır)", async () => {
    // Önceki testin LLM'siz atlanan konuşması bu turda yanıtlanmasın diye kapatılır.
    await prisma.conversation.updateMany({ where: { workspaceId, status: "ACTIVE" }, data: { status: "CLOSED" } });
    const hours = (h: number) => new Date(Date.now() - h * 3600 * 1000);
    const stale = await prisma.conversation.create({
      data: { leadId, workspaceId, channel: "WHATSAPP", status: "ACTIVE", firstResponseAt: hours(30), initiatedBy: "bot" },
    });
    await prisma.message.create({ data: { conversationId: stale.id, direction: "INCOMING", channel: "WHATSAPP", content: "Hallo", sender: "external", createdAt: hours(31) } });
    await prisma.message.create({ data: { conversationId: stale.id, direction: "OUTGOING", channel: "WHATSAPP", content: "Willkommen (bot)", sender: "bot", createdAt: hours(30) } });
    await prisma.message.create({ data: { conversationId: stale.id, direction: "INCOMING", channel: "WHATSAPP", content: "Ist noch jemand da?", sender: "external", createdAt: hours(25) } });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(llmResponse("Ja!"));
    const result = await runAssistant({ llm, transport, senders: { whatsapp: vi.fn(async () => ({ id: "x", error: null })) }, workspaceId });
    expect(result).toMatchObject({ replied: 0, escalated: 0 });
    expect(transport).not.toHaveBeenCalled();
    expect(await outgoing(stale.id)).toHaveLength(1);
  });

  it("deneme sınırındaki konuşmalar tur limitini doldurup yeni adayları açlığa sürüklemez (starvation)", async () => {
    // Ayrı workspace: tur limiti yalnızca işlenebilir (deneme sınırını aşmamış) adaylara uygulanmalı.
    const org = await prisma.organization.create({
      data: { name: "Starvation fixture", slug: `starvation-${suffix}`, workspaces: { create: { name: "W2", slug: "w2" } } },
      include: { workspaces: true },
    });
    const ws = org.workspaces[0]!.id;
    const lead = await prisma.lead.create({
      data: { workspaceId: ws, organizationId: org.id, firstName: "Test", lastName: "Lead", phone: encryptField(LEAD_PHONE), language: "de", channel: "WHATSAPP" },
    });
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    // İki "takılı" konuşma: deneme sınırında, daha eski son gelen mesaj → SQL/LIMIT'te önce gelir.
    for (const ageMin of [30, 20]) {
      const c = await prisma.conversation.create({
        data: { leadId: lead.id, workspaceId: ws, channel: "WHATSAPP", status: "ACTIVE", firstResponseAt: minutesAgo(ageMin + 1), initiatedBy: "bot" },
      });
      await prisma.message.create({
        data: { conversationId: c.id, direction: "INCOMING", channel: "WHATSAPP", content: "Hallo", sender: "external", createdAt: minutesAgo(ageMin), metadata: { assistantAttempts: ASSISTANT_MAX_ATTEMPTS } },
      });
    }
    // Daha yeni, işlenebilir aday (acil → LLM gerekmez, devredilir).
    const fresh = await prisma.conversation.create({
      data: { leadId: lead.id, workspaceId: ws, channel: "WHATSAPP", status: "ACTIVE", firstResponseAt: minutesAgo(11), initiatedBy: "bot" },
    });
    await prisma.message.create({
      data: { conversationId: fresh.id, direction: "INCOMING", channel: "WHATSAPP", content: "Es ist dringend, starke Blutung", sender: "external", createdAt: minutesAgo(10) },
    });
    const whatsapp = vi.fn(async () => ({ id: "wamid.mock", error: null }));
    // limit 2: SQL eskiden yalnızca iki takılı konuşmayı döndürüp JS'te eliyordu → yeni aday hiç işlenmezdi.
    const result = await runAssistant({ llm: null, senders: { whatsapp }, workspaceId: ws, limit: 2 });
    expect(result).toMatchObject({ escalated: 1, skipped: 0, failed: 0 });
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("ESCALATED");
    await prisma.organization.deleteMany({ where: { id: org.id } });
  });

  it("ayar açıkken randevuya dönüşen Instagram konuşmasındaki ekip yanıtları isteme örnek olarak girer (ADR-0027)", async () => {
    const org = await prisma.organization.create({
      data: { name: "Examples fixture", slug: `assist-examples-${suffix}`, workspaces: { create: { name: "W", slug: "w" } } },
      include: { workspaces: true },
    });
    const ws = org.workspaces[0]!.id;
    const staff = await prisma.user.create({ data: { email: `staff-${suffix}@example.test`, name: "Koordinatör" } });
    const lead = (status: "NEW" | "CONSULTATION_BOOKED" | "LOST", firstName: string, language = "de") =>
      prisma.lead.create({
        data: { workspaceId: ws, organizationId: org.id, firstName, lastName: "Beispiel", language, channel: "INSTAGRAM", status, metadata: { psid: `ps_${firstName}` } },
      });
    async function instagram(leadId: string, messages: Array<[direction: "INCOMING" | "OUTGOING", sender: string, content: string]>) {
      const c = await prisma.conversation.create({ data: { leadId, workspaceId: ws, channel: "INSTAGRAM", status: "CLOSED", firstResponseAt: past } });
      let offset = 0;
      for (const [direction, sender, content] of messages)
        await prisma.message.create({
          data: { conversationId: c.id, direction, channel: "INSTAGRAM", content, sender, createdAt: new Date(past.getTime() - 3_600_000 + offset++ * 1000) },
        });
    }
    // Dönüşen konuşma: hastanın yazdığı ve asistanın yanıtı örnek olmaz; yalnızca insan ekip yanıtları.
    await instagram((await lead("CONSULTATION_BOOKED", "Hildegard")).id, [
      ["INCOMING", "external", "Ich hatte schon zwei Operationen und nehme Blutverdünner."],
      ["OUTGOING", "ai", "Automatische Antwort des Assistenten."],
      ["OUTGOING", staff.id, "Guten Tag Hildegard, vielen Dank für Ihre Nachricht! Erreichbar unter +49 151 1234567."],
      ["OUTGOING", "system", "Koordinatör devraldı."],
      ["OUTGOING", staff.id, "Unsere Koordinatorin meldet sich morgen bei Ihnen."],
    ]);
    // Dönüşmeyen ve başka dildeki konuşmalar örnek olmaz.
    await instagram((await lead("LOST", "Verloren")).id, [["OUTGOING", staff.id, "Antwort an verlorenen Lead."]]);
    await instagram((await lead("CONSULTATION_BOOKED", "Turkish", "tr")).id, [["OUTGOING", staff.id, "Türkçe ekip yanıtı."]]);

    const current = await lead("NEW", "Aktuell");
    const active = await prisma.conversation.create({
      data: { leadId: current.id, workspaceId: ws, channel: "INSTAGRAM", status: "ACTIVE", firstResponseAt: past, initiatedBy: "bot" },
    });
    const inbound = (content: string) =>
      prisma.message.create({ data: { conversationId: active.id, direction: "INCOMING", channel: "INSTAGRAM", content, sender: "external" } });
    await inbound("Hallo, ich interessiere mich für eine Behandlung.");
    const messenger = vi.fn(async () => ({ id: "mid.mock", error: null }));
    const run = async () => {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(llmResponse("Gerne helfe ich Ihnen weiter."));
      expect(await runAssistant({ llm, transport, senders: { messenger }, workspaceId: ws })).toMatchObject({ replied: 1, failed: 0 });
      return JSON.parse(String(transport.mock.calls[0]![1]?.body)).system as string;
    };

    // Ayar kapalı (varsayılan): örnek yok, sürüm değişmez.
    expect(await run()).not.toContain("Style examples");
    expect(await prisma.llmCallLog.count({ where: { workspaceId: ws, promptVersion: "lead-assistant-v1" } })).toBe(1);

    await prisma.organization.update({ where: { id: org.id }, data: { assistantExamplesEnabled: true } });
    await inbound("Wie geht es weiter?");
    const system = await run();
    expect(system).toContain("Style examples");
    expect(system).toContain("- Guten Tag [ad], vielen Dank für Ihre Nachricht! Erreichbar unter [telefon].");
    expect(system).toContain("- Unsere Koordinatorin meldet sich morgen bei Ihnen.");
    for (const leaked of ["Hildegard", "Blutverdünner", "Operationen", "1234567", "Automatische Antwort", "devraldı", "verlorenen", "Türkçe"])
      expect(system).not.toContain(leaked);
    expect(await prisma.llmCallLog.count({ where: { workspaceId: ws, promptVersion: "lead-assistant-v1-ex1" } })).toBe(1);

    await prisma.organization.deleteMany({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: staff.id } });
  });
});
