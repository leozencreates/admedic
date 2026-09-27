import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
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

import { encrypt } from "../app/_lib/encrypt";
import { POST as webhookPost } from "../app/api/webhooks/meta/route";
import { GET as refetchGet, POST as refetchPost } from "../app/api/leads/refetch/route";
import { GET as leadGet } from "../app/api/leads/[id]/route";
import { POST as reviewSyncPost } from "../app/api/meta/review-sync/route";
import { GET as campaignsGet } from "../app/api/campaigns/route";
import { refetchPendingLeads } from "../app/_lib/lead-refetch";

/**
 * ADR-0015: Instant Form rızası → ConsentRecord, alanları çekilemeyen lead'lerin yeniden çekimi ve reklam
 * düzeyinde Meta inceleme senkronu (AD_DISAPPROVED uyarısı).
 */

const WEBHOOK_URL = "http://localhost:3000/api/webhooks/meta";
const APP_SECRET = "app-secret-fixture";

function signedRequest(payload: unknown, secret: string) {
  const body = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return new Request(WEBHOOK_URL, {
    method: "POST",
    body,
    headers: { "x-hub-signature-256": signature, "content-type": "application/json" },
  });
}

function req(url: string, method: string, bodyObj?: unknown) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}

function leadgenPayload(pageId: string, value: Record<string, unknown>) {
  return { object: "page", entry: [{ id: pageId, time: 1758870000, changes: [{ field: "leadgen", value }] }] };
}

/** Graph `GET /{leadgen_id}` yanıtı (gerçek biçim). */
function graphLead(id: string, formId: string, phone: string, checked: string | null) {
  return {
    id,
    created_time: "2026-09-27T08:00:00+0000",
    ad_id: "ad_graph_1",
    adset_id: "as_graph_1",
    campaign_id: "cmp_graph_1",
    form_id: formId,
    is_organic: false,
    platform: "ig",
    field_data: [
      { name: "full_name", values: ["Ada Graph"] },
      { name: "phone_number", values: [phone] },
      { name: "email", values: [`${id}@example.invalid`] },
    ],
    ...(checked === null ? {} : { custom_disclaimer_responses: [{ checkbox_key: "kvkk_consent", is_checked: checked }] }),
  };
}

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("Instant Form rızası, bekleyen lead çekimi ve reklam incelemesi (ADR-0015)", () => {
  const suffix = randomBytes(6).toString("hex");
  const secret = randomBytes(16).toString("hex");
  const pageA = `pg-${suffix}-a`;
  const pageB = `pg-${suffix}-b`;
  const formA = `form-${suffix}-a`;
  const formB = `form-${suffix}-b`;
  const orgIds: string[] = [];
  const workspaceIds: string[] = [];
  const userIds: string[] = [];
  let campaignId = "";
  let rejectedAdId = "";
  let okAdId = "";

  beforeAll(async () => {
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    vi.stubEnv("META_WEBHOOK_SECRET", secret);
    vi.stubEnv("WHATSAPP_GREETING_TEMPLATE", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("LLM_MODEL", "");
    const owner = await prisma.user.create({ data: { email: `owner-${suffix}@example.invalid` } });
    userIds.push(owner.id);
    for (const key of ["a", "b"]) {
      const org = await prisma.organization.create({
        data: {
          name: `Consent fixture ${key}`,
          slug: `consent-${suffix}-${key}`,
          ...(key === "a" ? { members: { create: { userId: owner.id, role: "OWNER" } } } : {}),
          workspaces: { create: { name: "W", slug: "main" } },
        },
        include: { workspaces: true },
      });
      orgIds.push(org.id);
      workspaceIds.push(org.workspaces[0]!.id);
    }
    await prisma.metaConnection.create({
      data: { orgId: orgIds[0]!, type: "PAGE", name: "Sayfa A", pageId: pageA, status: "CONNECTED", tokenCiphertext: encrypt("page-token-a") },
    });
    await prisma.metaConnection.create({
      data: { orgId: orgIds[1]!, type: "PAGE", name: "Sayfa B", pageId: pageB, status: "CONNECTED", tokenCiphertext: encrypt("page-token-b") },
    });
    const bm = await prisma.metaConnection.create({
      data: { orgId: orgIds[0]!, type: "BUSINESS_MANAGER", status: "CONNECTED", tokenCiphertext: encrypt("user-token-a") },
    });
    const account = await prisma.adAccount.create({
      data: { orgId: orgIds[0]!, workspaceId: workspaceIds[0]!, connectionId: bm.id, name: "Hesap", status: "ACTIVE", metaAccountId: `act_${suffix}` },
    });
    const campaign = await prisma.campaign.create({
      data: {
        adAccountId: account.id,
        workspaceId: workspaceIds[0]!,
        name: `İnceleme ${suffix}`,
        status: "PAUSED",
        workflowStatus: "PUBLISHED_PAUSED",
        metaCampaignId: `cmp_${suffix}`,
      },
    });
    campaignId = campaign.id;
    const adSet = await prisma.adSet.create({
      data: { campaignId, workspaceId: workspaceIds[0]!, name: "AS", status: "PAUSED", metaAdSetId: `as_${suffix}` },
    });
    rejectedAdId = (await prisma.ad.create({
      data: { adSetId: adSet.id, workspaceId: workspaceIds[0]!, name: "Reklam DE", status: "PAUSED", metaAdId: `ad_mock_pub_rejected_${suffix}` },
    })).id;
    okAdId = (await prisma.ad.create({
      data: { adSetId: adSet.id, workspaceId: workspaceIds[0]!, name: "Reklam TR", status: "PAUSED", metaAdId: `ad_mock_pub_${suffix}` },
    })).id;
    const formRow = (metaFormId: string, orgIndex: number, text: string) => ({
      orgId: orgIds[orgIndex]!,
      workspaceId: workspaceIds[orgIndex]!,
      campaignId,
      draftId: `draft-${suffix}`,
      metaFormId,
      pageId: orgIndex === 0 ? pageA : pageB,
      language: "DE",
      consentKey: "kvkk_consent",
      consentText: text,
      privacyPolicyUrl: "https://klinik.example/datenschutz",
    });
    await prisma.leadForm.create({ data: formRow(formA, 0, "Einwilligung A — ☑ Ich willige ein.") });
    await prisma.leadForm.create({ data: formRow(formB, 1, "Başka kuruluşun metni") });
    const token = randomBytes(32).toString("hex");
    await prisma.webSession.create({
      data: { tokenHash: tokenHash(token), userId: owner.id, workspaceId: workspaceIds[0]!, expiresAt: new Date(Date.now() + 120_000) },
    });
    cookieJar.set(SESSION_COOKIE, token);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    loadEnv({ fresh: true });
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.leadForm.deleteMany({ where: { metaFormId: { in: [formA, formB] } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  const leadByLeadgen = (leadgenId: string, orgIndex = 0) =>
    prisma.lead.findUniqueOrThrow({
      where: { organizationId_leadgenId: { organizationId: orgIds[orgIndex]!, leadgenId } },
      include: { consentRecords: true, conversations: true },
    });

  it("mock Graph yanıtındaki işaretli kutu → DATA_PROCESSING GRANTED, formun yayın anındaki metni; pazarlama rızası değişmez", async () => {
    const res = await webhookPost(
      signedRequest(leadgenPayload(pageA, { leadgen_id: `lg-${suffix}-1`, page_id: pageA, form_id: formA, created_time: 1758870000 }), secret),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processed: 1 });
    const lead = await leadByLeadgen(`lg-${suffix}-1`);
    expect(lead.consentGiven).toBe(false);
    expect(lead.consentRecords).toHaveLength(1);
    const consent = lead.consentRecords[0]!;
    expect(consent).toMatchObject({
      type: "DATA_PROCESSING",
      status: "GRANTED",
      source: "INSTANT_FORM",
      consentText: "Einwilligung A — ☑ Ich willige ein.",
    });
    expect(consent.evidence).toMatchObject({ metaFormId: formA, checkboxKey: "kvkk_consent", basis: "CHECKBOX_RESPONSE", response: "checked" });
    expect((lead.metadata as Record<string, unknown>).disclaimer_responses).toEqual([{ key: "kvkk_consent", checked: true }]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: lead.id, action: "LEAD_INGESTED" } });
    expect(audit.after).toMatchObject({ consent: { status: "GRANTED", reason: "RECORDED", basis: "CHECKBOX_RESPONSE" } });

    // Panel lead detayı kaydı gösterir.
    const detail = await leadGet(req(`/api/leads/${lead.id}`, "GET"), { params: Promise.resolve({ id: lead.id }) });
    const detailJson = await detail.json();
    expect(detailJson.lead.pendingFetch).toBeNull();
    expect(detailJson.lead.consents[0]).toMatchObject({ type: "DATA_PROCESSING", status: "GRANTED", source: "INSTANT_FORM", basis: "CHECKBOX_RESPONSE", formLanguage: "DE" });
  });

  it("kutu yanıtı taşımayan veri (webhook içi field_data) → zorunlu kutu dayanağı; bilinmeyen/başka kuruluşun formu → kayıt yok", async () => {
    const withFields = (leadgenId: string, formId: string) =>
      leadgenPayload(pageA, {
        leadgen_id: leadgenId,
        page_id: pageA,
        form_id: formId,
        field_data: [
          { name: "full_name", values: ["Webhook Kişi"] },
          { name: "email", values: [`${leadgenId}@example.invalid`] },
        ],
      });
    expect((await webhookPost(signedRequest(withFields(`lg-${suffix}-2`, formA), secret))).status).toBe(200);
    const required = await leadByLeadgen(`lg-${suffix}-2`);
    expect(required.consentRecords).toHaveLength(1);
    expect(required.consentRecords[0]!.evidence).toMatchObject({ basis: "REQUIRED_CHECKBOX", response: null });
    expect((required.metadata as Record<string, unknown>).disclaimer_responses).toBeNull();

    expect((await webhookPost(signedRequest(withFields(`lg-${suffix}-3`, formB), secret))).status).toBe(200);
    expect((await leadByLeadgen(`lg-${suffix}-3`)).consentRecords).toHaveLength(0);
    expect((await webhookPost(signedRequest(withFields(`lg-${suffix}-4`, `unknown-${suffix}`), secret))).status).toBe(200);
    expect((await leadByLeadgen(`lg-${suffix}-4`)).consentRecords).toHaveLength(0);
  });

  it("gerçek Graph: işaretsiz kutu DENIED; token hatasında lead bekler, elle yeniden çekim tamamlar (appsecret_proof ile)", async () => {
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "false", META_API_VERSION: "v26.0", META_APP_SECRET: APP_SECRET } });
    let failToken = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const leadgenId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      if (failToken)
        return Response.json({ error: { code: 190, message: "Error validating access token" } }, { status: 400 });
      return Response.json(graphLead(leadgenId, formA, leadgenId.endsWith("-6") ? "+49151 5550006" : "+49151 5550005", leadgenId.endsWith("-5") ? "" : "1"));
    });

    expect((await webhookPost(signedRequest(leadgenPayload(pageA, { leadgen_id: `lg-${suffix}-5`, page_id: pageA, form_id: formA }), secret))).status).toBe(200);
    const denied = await leadByLeadgen(`lg-${suffix}-5`);
    expect(denied.firstName).toBe("Ada");
    expect(denied.consentRecords[0]).toMatchObject({ status: "DENIED", acceptedAt: null, source: "INSTANT_FORM" });
    expect(denied.consentRecords[0]!.evidence).toMatchObject({ basis: "CHECKBOX_RESPONSE", response: "unchecked" });
    const firstCall = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(firstCall.searchParams.get("fields")).toContain("custom_disclaimer_responses");
    expect(firstCall.searchParams.get("appsecret_proof")).toBe(createHmac("sha256", APP_SECRET).update("page-token-a").digest("hex"));

    // Token geçersiz: lead kimlikle kaydedilir, alanlar ve rıza bekler (zorunlu kutu dayanağıyla rıza yazılır).
    failToken = true;
    expect((await webhookPost(signedRequest(leadgenPayload(pageA, { leadgen_id: `lg-${suffix}-6`, page_id: pageA, form_id: formA }), secret))).status).toBe(200);
    const stub = await leadByLeadgen(`lg-${suffix}-6`);
    const stubMeta = stub.metadata as Record<string, unknown>;
    expect(stubMeta).toMatchObject({ pendingFetch: true, fetchAttempts: 1 });
    expect(stub.phone).toBeNull();
    expect(stub.conversations).toHaveLength(0);
    expect(stub.consentRecords[0]!.evidence).toMatchObject({ basis: "REQUIRED_CHECKBOX" });
    expect((await (await refetchGet()).json()).pending).toBe(1);

    // Otomatik deneme geri çekilme süresinde atlanır; elle deneme hâlâ başarısızsa deneme sayısı artar.
    const auto = await refetchPendingLeads({ orgId: orgIds[0]! });
    expect(auto).toMatchObject({ attempted: 0, skipped: 1, remaining: 1 });
    const manualFail = await refetchPost(req("/api/leads/refetch", "POST", { leadId: stub.id }));
    expect(await manualFail.json()).toMatchObject({ attempted: 1, failed: 1, recovered: 0, remaining: 1 });
    expect(((await leadByLeadgen(`lg-${suffix}-6`)).metadata as Record<string, unknown>).fetchAttempts).toBe(2);

    // Token düzeldi: elle deneme alanları tamamlar, WhatsApp konuşması açılır, rıza ikinci kez yazılmaz.
    failToken = false;
    const manual = await refetchPost(req("/api/leads/refetch", "POST", { leadId: stub.id }));
    expect(await manual.json()).toMatchObject({ attempted: 1, recovered: 1, remaining: 0 });
    const recovered = await leadByLeadgen(`lg-${suffix}-6`);
    const recoveredMeta = recovered.metadata as Record<string, unknown>;
    expect(recoveredMeta.pendingFetch).toBeUndefined();
    expect(recoveredMeta.fetchRecoveredAt).toEqual(expect.any(String));
    expect(recoveredMeta.data_source).toBe("graph");
    expect(recovered.firstName).toBe("Ada");
    expect(recovered.phone).toBeTruthy();
    expect(recovered.country).toBe("DE");
    expect(recovered.lookupHash).toBeTruthy();
    expect(recovered.conversations.map((c) => c.channel)).toEqual(["WHATSAPP"]);
    expect(recovered.consentRecords).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { entityId: recovered.id, action: "LEAD_FETCH_RECOVERED" } })).toBe(1);
    expect((await refetchPost(req("/api/leads/refetch", "POST", { leadId: recovered.id }))).status).toBe(409);
    expect((await (await refetchGet()).json()).pending).toBe(0);
  });

  it("aynı kuruluşa sorunsuz çekilen yeni lead webhook'u, bekleyen eski lead'leri yanıttan sonra tamamlar", async () => {
    const pending = await prisma.lead.create({
      data: {
        workspaceId: workspaceIds[0]!,
        organizationId: orgIds[0]!,
        firstName: "Konuk",
        lastName: "",
        channel: "LEAD_AD",
        leadgenId: `lg-${suffix}-7`,
        metadata: {
          source: "lead_ads",
          leadgen_id: `lg-${suffix}-7`,
          page_id: pageA,
          form_id: formA,
          pendingFetch: true,
          fetchError: "eski hata",
          fetchAttempts: 3,
          lastFetchAttemptAt: new Date(Date.now() - 3_600_000).toISOString(),
        },
      },
    });
    // Mock mod: yeni lead sorunsuz çekilir → kuruluş "sağlıklı" → bekleyen lead yeniden denenir.
    expect((await webhookPost(signedRequest(leadgenPayload(pageA, { leadgen_id: `lg-${suffix}-8`, page_id: pageA, form_id: formA }), secret))).status).toBe(200);
    const done = await prisma.lead.findUniqueOrThrow({ where: { id: pending.id }, include: { consentRecords: true } });
    expect((done.metadata as Record<string, unknown>).pendingFetch).toBeUndefined();
    expect(done.firstName).not.toBe("Konuk");
    expect(done.consentRecords.map((c) => c.status)).toEqual(["GRANTED"]);
  });

  it("reklam incelemesi: reddedilen reklam uyarı + denetim üretir, tekrar senkron uyarıyı çoğaltmaz, red kalkınca uyarı çözülür", async () => {
    const sync = () => reviewSyncPost(req("/api/meta/review-sync", "POST", { campaignId }));
    const first = await sync();
    expect(first.status).toBe(200);
    expect((await first.json()).campaigns[0]).toMatchObject({ campaignId, status: "DISAPPROVED", ads: 2, newlyDisapproved: 1 });
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.metaReviewStatus).toBe("DISAPPROVED");
    expect(campaign.metaReviewCheckedAt).toBeInstanceOf(Date);
    expect(campaign.metaRejectionReason).toMatchObject({
      summary: { status: "DISAPPROVED", total: 2, disapproved: 1 },
      ads: [{ adId: rejectedAdId, name: "Reklam DE", reasons: ["İçerik sağlık iddiaları içeriyor."] }],
    });
    const rejected = await prisma.ad.findUniqueOrThrow({ where: { id: rejectedAdId } });
    expect(rejected.metaEffectiveStatus).toBe("DISAPPROVED");
    expect(rejected.metaReviewFeedback).toMatchObject({ global: { personal_health: "İçerik sağlık iddiaları içeriyor." } });
    const ok = await prisma.ad.findUniqueOrThrow({ where: { id: okAdId } });
    expect(ok.metaEffectiveStatus).toBe("ACTIVE");
    expect(ok.metaReviewFeedback).toBeNull();
    const alerts = await prisma.alert.findMany({ where: { workspaceId: workspaceIds[0]!, type: "AD_DISAPPROVED" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ entityType: "AD", entityId: rejectedAdId, severity: "CRITICAL", status: "OPEN" });
    expect(await prisma.auditLog.count({ where: { entityId: rejectedAdId, action: "META_AD_DISAPPROVED" } })).toBe(1);

    // Panel özeti.
    const list = await (await campaignsGet()).json();
    const row = list.campaigns.find((c: { id: string }) => c.id === campaignId);
    expect(row.review).toMatchObject({ status: "DISAPPROVED", disapproved: 1, total: 2, ads: [{ name: "Reklam DE", effectiveStatus: "DISAPPROVED" }] });

    expect((await (await sync()).json()).campaigns[0]).toMatchObject({ status: "DISAPPROVED", newlyDisapproved: 0 });
    expect(await prisma.alert.count({ where: { workspaceId: workspaceIds[0]!, type: "AD_DISAPPROVED" } })).toBe(1);

    // Düzeltilen reklam (mock: kimlikte "rejected" yok) → uyarı çözülür, kampanya sorunsuz.
    await prisma.ad.update({ where: { id: rejectedAdId }, data: { metaAdId: `ad_mock_pub_fixed_${suffix}` } });
    expect((await (await sync()).json()).campaigns[0]).toMatchObject({ status: "NO_ISSUES" });
    const resolved = await prisma.alert.findFirstOrThrow({ where: { workspaceId: workspaceIds[0]!, type: "AD_DISAPPROVED" } });
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).metaRejectionReason).toBeNull();
  });
});
