import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { decryptField, encryptField, loadEnv } from "@admedic/config";
import { prisma } from "@admedic/database";

import { MockVoiceClient, type PlaceCallInput, type PlacedCall, type VoiceClient } from "./client";
import { applyVoiceEvent, leadCallState, reapStaleCalls, runAutoCalls, startVoiceCall, STALE_CALL_MS } from "./service";

/** İstanbul 13:00 — arama saatleri içinde. */
const NOON = new Date("2026-10-01T10:00:00Z");

/** Gerçek sağlayıcı gibi davranır: arama INITIATED kalır, sonuç webhook ile gelir. */
class LiveLikeClient implements VoiceClient {
  readonly mock = false;
  readonly missingConfig: string[] = [];
  readonly calls: PlaceCallInput[] = [];
  fail: Error | null = null;
  async placeCall(input: PlaceCallInput): Promise<PlacedCall> {
    if (this.fail) throw this.fail;
    this.calls.push(input);
    return { conversationId: `conv_${input.dynamicVariables.call_ref}`, providerCallId: "CA_test" };
  }
}

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("sesli arama akışı (DB)", () => {
  const suffix = randomBytes(6).toString("hex");
  let orgId = "";
  let workspaceId = "";

  async function lead(overrides: { phone?: string | null; status?: "NEW" | "QUALIFIED" | "LOST"; consent?: boolean } = {}) {
    const row = await prisma.lead.create({
      data: {
        workspaceId,
        organizationId: orgId,
        firstName: "Ayşe",
        lastName: `Test-${randomBytes(3).toString("hex")}`,
        phone: overrides.phone === null ? null : encryptField(overrides.phone ?? `+90532${Math.floor(1_000_000 + Math.random() * 8_999_999)}`),
        language: "tr",
        interestedService: "Saç ekimi",
        status: overrides.status ?? "NEW",
      },
    });
    if (overrides.consent !== false)
      await prisma.consentRecord.create({
        data: {
          leadId: row.id,
          workspaceId,
          type: "PHONE_CALL",
          status: "GRANTED",
          consentText: "Telefonla aranmayı kabul ediyorum.",
          acceptedAt: new Date(),
          source: "PANEL",
        },
      });
    return row.id;
  }

  beforeAll(async () => {
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "true" } });
    const org = await prisma.organization.create({
      data: { name: "Voice fixture", slug: `voice-${suffix}`, workspaces: { create: { name: "W", slug: "w" } } },
      include: { workspaces: true },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0]!.id;
    await prisma.clinicProfile.create({ data: { workspaceId, name: "Örnek Klinik", slug: `voice-${suffix}`, languages: ["TR"] } });
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: orgId } });
    vi.unstubAllEnvs();
    loadEnv({ fresh: true });
    await prisma.$disconnect();
  });

  it("müsait lead'i arar; ajana sağlık bilgisi gitmez ve açılışta bildirim vardır", async () => {
    const leadId = await lead();
    const client = new LiveLikeClient();
    const call = await startVoiceCall(prisma, client, { leadId, workspaceId, trigger: "MANUAL", requestedById: null, now: NOON });
    expect(call).toMatchObject({ status: "INITIATED", trigger: "MANUAL", conversationId: `conv_${call.id}` });
    const sent = client.calls[0]!;
    expect(sent.toNumber).toMatch(/^\+90532\d{7}$/);
    expect(sent.language).toBe("tr");
    expect(sent.firstMessage).toContain("yapay zekâ");
    expect(sent.firstMessage).toContain("Örnek Klinik");
    expect(sent.dynamicVariables).toEqual({ call_ref: call.id, lead_first_name: "Ayşe", clinic_name: "Örnek Klinik", language: "tr" });
    expect(JSON.stringify(sent)).not.toContain("Saç ekimi");
    const audit = await prisma.auditLog.findFirst({ where: { orgId, action: "VOICE_CALL_STARTED", entityId: leadId } });
    expect(audit).not.toBeNull();
  });

  it("rızası olmayan ya da süren araması olan lead aranmaz ve kayıt açılmaz", async () => {
    const noConsent = await lead({ consent: false });
    const client = new LiveLikeClient();
    await expect(
      startVoiceCall(prisma, client, { leadId: noConsent, workspaceId, trigger: "MANUAL", requestedById: null, now: NOON }),
    ).rejects.toThrow(/rızası/);
    expect(await prisma.voiceCall.count({ where: { leadId: noConsent } })).toBe(0);

    const busy = await lead();
    await startVoiceCall(prisma, client, { leadId: busy, workspaceId, trigger: "MANUAL", requestedById: null, now: NOON });
    await expect(
      startVoiceCall(prisma, client, { leadId: busy, workspaceId, trigger: "MANUAL", requestedById: null, now: NOON }),
    ).rejects.toThrow(/Sonucu bekleyen/);
    expect(await prisma.voiceCall.count({ where: { leadId: busy } })).toBe(1);
  });

  it("başka çalışma alanının lead'i bulunamaz", async () => {
    const leadId = await lead();
    await expect(
      startVoiceCall(prisma, new LiveLikeClient(), { leadId, workspaceId: "other-workspace", trigger: "MANUAL", requestedById: null, now: NOON }),
    ).rejects.toThrow(/bulunamadı/);
    expect(await leadCallState(prisma, { leadId, workspaceId: "other-workspace" }, "MANUAL", NOON)).toBeNull();
  });

  it("sağlayıcı hatasında arama FAILED kalır ve deneme sayılmaz", async () => {
    const leadId = await lead();
    const client = new LiveLikeClient();
    client.fail = new Error("boom");
    await expect(
      startVoiceCall(prisma, client, { leadId, workspaceId, trigger: "MANUAL", requestedById: null, now: NOON }),
    ).rejects.toThrow("boom");
    const failed = await prisma.voiceCall.findFirstOrThrow({ where: { leadId } });
    expect(failed).toMatchObject({ status: "FAILED", startedAt: null, failureReason: "not_started" });
    const state = await leadCallState(prisma, { leadId, workspaceId }, "MANUAL", NOON);
    expect(state).toMatchObject({ blockers: [], facts: { attempts: 0, activeCall: false } });
  });

  it("transkript olayı aramayı kapatır, özeti şifreli saklar ve NEW lead'i CONTACTED yapar; tekrar gelen olay yazmaz", async () => {
    const leadId = await lead();
    const call = await startVoiceCall(prisma, new LiveLikeClient(), { leadId, workspaceId, trigger: "MANUAL", requestedById: null, now: NOON });
    const event = {
      type: "transcript" as const,
      conversationId: call.conversationId!,
      callRef: call.id,
      status: "done",
      outcome: "success",
      summary: "Lead geri aranmak istedi.",
      durationSecs: 80,
      terminationReason: null,
    };
    expect(await applyVoiceEvent(prisma, event, NOON)).toEqual({ handled: true, callId: call.id });
    const done = await prisma.voiceCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(done).toMatchObject({ status: "COMPLETED", outcome: "success", durationSecs: 80 });
    expect(done.summary).not.toContain("geri aranmak");
    expect(decryptField(done.summary!)).toBe("Lead geri aranmak istedi.");
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("CONTACTED");

    await applyVoiceEvent(prisma, { ...event, summary: "ikinci teslim", durationSecs: 1 }, NOON);
    const again = await prisma.voiceCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(again.durationSecs).toBe(80);

    // Ajan görüştü: otomatik tur yeniden aramaz, koordinatör bekleme süresinden sonra arayabilir.
    const later = new Date(NOON.getTime() + 25 * 3600_000);
    expect((await leadCallState(prisma, { leadId, workspaceId }, "AUTO", later))!.blockers).toEqual(["ALREADY_REACHED"]);
  });

  it("konuşma kimliği kaydedilemediyse olay call_ref ile eşlenir; meşgul/yanıtsız durumları yazar", async () => {
    const leadId = await lead();
    const call = await startVoiceCall(prisma, new LiveLikeClient(), { leadId, workspaceId, trigger: "MANUAL", requestedById: null, now: NOON });
    await prisma.voiceCall.update({ where: { id: call.id }, data: { conversationId: null } });
    const result = await applyVoiceEvent(
      prisma,
      { type: "initiation_failure", conversationId: "conv_late", callRef: call.id, failureReason: "no-answer" },
      NOON,
    );
    expect(result.handled).toBe(true);
    expect(await prisma.voiceCall.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "NO_ANSWER", conversationId: "conv_late" });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("NEW");
    expect(await applyVoiceEvent(prisma, { type: "initiation_failure", conversationId: "conv_unknown", callRef: null, failureReason: "busy" })).toEqual({ handled: false });
  });

  it("deneme modunda arama hemen kapanır ve lead durumu değişmez", async () => {
    const leadId = await lead();
    const call = await startVoiceCall(prisma, new MockVoiceClient(), { leadId, workspaceId, trigger: "MANUAL", requestedById: null, now: NOON });
    expect(call).toMatchObject({ status: "COMPLETED", durationSecs: 0, outcome: "unknown" });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("NEW");
  });

  it("sonucu gelmeyen eski arama kapatılır", async () => {
    const leadId = await lead();
    const call = await startVoiceCall(prisma, new LiveLikeClient(), { leadId, workspaceId, trigger: "MANUAL", requestedById: null, now: NOON });
    await prisma.voiceCall.update({ where: { id: call.id }, data: { createdAt: new Date(NOON.getTime() - STALE_CALL_MS - 1000) } });
    expect(await reapStaleCalls(prisma, NOON)).toBeGreaterThanOrEqual(1);
    expect(await prisma.voiceCall.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "FAILED", failureReason: "no_result" });
  });

  it("otomatik tur yalnızca ayarı açık kuruluşta ve müsait lead'lerde çalışır", async () => {
    await prisma.voiceCall.deleteMany({ where: { organizationId: orgId } });
    await prisma.lead.deleteMany({ where: { organizationId: orgId } });
    const callable = await lead();
    const lost = await lead({ status: "LOST" });
    const noConsent = await lead({ consent: false });
    const client = new LiveLikeClient();

    expect(await runAutoCalls(prisma, client, { now: NOON, organizationId: orgId })).toEqual({ started: 0, skipped: 0, failed: 0 });
    await prisma.organization.update({ where: { id: orgId }, data: { voiceAutoCallEnabled: true } });

    // Arama saatleri dışında (İstanbul 23:00) kimse aranmaz.
    const night = new Date("2026-10-01T20:00:00Z");
    expect(await runAutoCalls(prisma, client, { now: night, organizationId: orgId })).toMatchObject({ started: 0 });

    const result = await runAutoCalls(prisma, client, { now: NOON, organizationId: orgId });
    expect(result).toEqual({ started: 1, skipped: 0, failed: 0 });
    expect(await prisma.voiceCall.count({ where: { leadId: callable, trigger: "AUTO", status: "INITIATED" } })).toBe(1);
    expect(await prisma.voiceCall.count({ where: { leadId: { in: [lost, noConsent] } } })).toBe(0);

    // İkinci tur: süren arama olduğu için aynı lead yeniden aranmaz.
    expect(await runAutoCalls(prisma, client, { now: NOON, organizationId: orgId })).toMatchObject({ started: 0 });
  });
});
