import { describe, expect, it } from "vitest";
import { RefMap } from "../app/_lib/assistant/ref-map";
import {
  scrubText,
  sanitizeAlertList,
  sanitizeCampaignDetail,
  sanitizeCampaignList,
  sanitizeDecisionList,
  sanitizeInsights,
  sanitizeLeadStats,
  sanitizeRecommendationList,
  sanitizeShellSummary,
  sanitizeSubscription,
  sanitizeWeeklyReport,
  sanitizeCreatedCampaign,
  sanitizeGeneratedCopy,
  sanitizeRefetchSummary,
  sanitizeStudioDraft,
  sanitizeSubmittedCampaign,
  sanitizeUpdatedAlert,
} from "../app/_lib/assistant/sanitize";

// Araç sonuçları ElevenLabs'e (üçüncü taraf) gider (ADR-0028 §4). Veriler bilerek sahtedir; gerçek kişi yoktur.
const PII = {
  firstName: "Sahteadı",
  lastName: "Örnekoğlu",
  email: "sahte.kisi@example.test",
  phone: "+90 555 000 00 00",
  service: "Saç ekimi FUE 4000 greft",
  message: "Merhaba, kalp rahatsızlığım var, ameliyat olabilir miyim?",
  coordinator: "Deneme Koordinatör",
  staff: "Deneme Personel",
  staffEmail: "personel@example.test",
};
const LEAD_ID = "lead_secret_db_id_123";

function fakeLead(i: number) {
  return {
    id: i === 0 ? LEAD_ID : `lead_fake_${i}`,
    firstName: PII.firstName,
    lastName: PII.lastName,
    email: PII.email,
    phone: PII.phone,
    country: "DE",
    language: "de",
    channel: "LEAD_AD",
    status: i % 2 ? "QUALIFIED" : "NEW",
    interestedService: PII.service,
    campaignId: "cmp_fake_1",
    createdAt: "2026-09-30T10:00:00.000Z",
    metadata: { note: PII.message, health: PII.service },
    consentGiven: true,
    inbox: {
      conversationStatus: "ESCALATED",
      handedOff: i === 0,
      claimedBy: PII.coordinator,
      claimedByMe: false,
      lastMessage: { at: "2026-09-30T10:00:00.000Z", direction: "INCOMING", party: "lead", preview: PII.message },
      needsReply: i < 3,
      waitingSince: "2026-09-30T10:00:00.000Z",
    },
  };
}

function expectNoPii(output: unknown) {
  const text = JSON.stringify(output);
  for (const value of Object.values(PII)) expect(text).not.toContain(value);
  expect(text).not.toContain("555");
  expect(text).not.toContain("@example.test");
  expect(text).not.toContain(LEAD_ID);
}

describe("sanitize: lead", () => {
  it("lead istatistiği ad, iletişim, mesaj, sağlık ve kimlik taşımaz; ref ve sayılar taşır", () => {
    const refs = new RefMap();
    const out = sanitizeLeadStats({ leads: Array.from({ length: 12 }, (_, i) => fakeLead(i)) }, refs);
    expectNoPii(out);
    expect(out.total).toBe(12);
    expect(out.recent).toHaveLength(10);
    expect(out.awaitingReply).toBe(3);
    expect(out.handedOffUnclaimed).toBe(1);
    expect(out.byStatus).toEqual({ NEW: 6, QUALIFIED: 6 });
    expect(out.recent[0].ref).toBe("l1");
    expect(refs.resolve("l1", "lead")).toBe(LEAD_ID);
    expect(Object.keys(out.recent[0]).sort()).toEqual(["awaitingReply", "channel", "date", "language", "ref", "status"]);
  });
});

describe("sanitize: lead ülke/dil/kanal beyaz listesi", () => {
  // Elle lead girişi (`POST /api/leads`) bu alanlara serbest metin kabul eder: ad + telefon yazılabilir.
  const FREE = `${PII.firstName} ${PII.lastName} ${PII.phone}`;

  it("ülke/dil/kanal normalize edilir; kalıba uymayan değer ne anahtar ne değer olarak gider, OTHER altında sayılır", () => {
    const leads = [
      { ...fakeLead(0), country: FREE, language: FREE, channel: FREE },
      { ...fakeLead(1), country: " de ", language: "DE", channel: "whatsapp" },
      { ...fakeLead(2), country: "Germany", language: "pt-BR", channel: "MANUAL" },
      { ...fakeLead(3), country: null, language: "zh_Hant", channel: null },
    ];
    const out = sanitizeLeadStats({ leads }, new RefMap());
    expectNoPii(out);
    expect(JSON.stringify(out)).not.toContain(PII.firstName);
    expect(out.byCountry).toEqual({ OTHER: 2, DE: 1, UNKNOWN: 1 });
    expect(out.byLanguage).toEqual({ OTHER: 1, de: 1, pt: 1, zh: 1 });
    expect(out.byChannel).toEqual({ OTHER: 2, WHATSAPP: 1, UNKNOWN: 1 });
    // Üç harfli kısa adlar ("Ali", "Ece") dil kodu sayılmaz.
    const named = sanitizeLeadStats({ leads: [{ ...fakeLead(4), language: "Ali" }, { ...fakeLead(5), language: "ece-tr" }] }, new RefMap());
    expect(named.byLanguage).toEqual({ OTHER: 2 });
    expect(out.recent.map((l) => [l.channel, l.language])).toEqual([
      ["OTHER", "OTHER"],
      ["WHATSAPP", "de"],
      ["OTHER", "pt"],
      [null, "zh"],
    ]);
  });

  it("içgörü ülke/dil kırılımı: serbest metin OTHER'a düşer, aynı anahtarlar birleşir", () => {
    const out = sanitizeInsights(
      {
        insights: {
          byCountry: [
            { country: "TR", leads: 4, qualified: 1 },
            { country: FREE, leads: 2, qualified: 1 },
            { country: `${PII.lastName} ${PII.email}`, leads: 3, qualified: 0 },
            { country: "de", leads: 1, qualified: 1 },
          ],
          byLanguage: [{ language: FREE, leads: 1, qualified: 0 }, { language: "ar", leads: 2, qualified: 2 }],
        },
      },
      new RefMap(),
    );
    expectNoPii(out);
    expect(out.byCountry).toEqual([
      { country: "OTHER", leads: 5, qualified: 1 },
      { country: "TR", leads: 4, qualified: 1 },
      { country: "DE", leads: 1, qualified: 1 },
    ]);
    expect(out.byLanguage).toEqual([
      { language: "ar", leads: 2, qualified: 2 },
      { language: "OTHER", leads: 1, qualified: 0 },
    ]);
  });
});

describe("sanitize: uyarı başlıkları", () => {
  const CONN_CUID = "cm1abc2def3ghi4jkl5mno6pq";
  const PERSON = "Sahte Personeladı";

  it("bağlantı etiketi gömen türler sabit başlık alır; AD_DISAPPROVED kimlik parçası atılır", () => {
    const refs = new RefMap();
    const alerts = [
      { id: "a_1", type: "META_DISCONNECTED", severity: "CRITICAL", status: "OPEN", title: `Meta bağlantısı REVOKED: ${PERSON}` },
      { id: "a_2", type: "META_DISCONNECTED", severity: "CRITICAL", status: "OPEN", title: `Meta bağlantısı EXPIRED: ${CONN_CUID}` },
      { id: "a_3", type: "TOKEN_EXPIRING", severity: "WARNING", status: "OPEN", title: `Meta token'ı süresi dolmak üzere: ${PERSON}` },
      { id: "a_4", type: "AD_DISAPPROVED", severity: "WARNING", status: "OPEN", title: "Meta reklamı reddetti: Saç ekimi — Taslak (de) #a1b2c3" },
    ];
    const list = sanitizeAlertList({ alerts }, refs);
    const weekly = sanitizeWeeklyReport({ report: { unreadAlerts: alerts } }, refs);
    // Kabuk bildirimleri tür taşımaz: başlık önekinden tanınır.
    const shell = sanitizeShellSummary({ notifications: alerts.map((a) => ({ id: a.id, severity: a.severity, title: a.title })) });
    for (const out of [list, weekly, shell]) {
      const text = JSON.stringify(out);
      expect(text).not.toContain(PERSON);
      expect(text).not.toContain("Personeladı");
      expect(text).not.toContain(CONN_CUID);
      expect(text).not.toContain("a1b2c3");
    }
    const titles = list.alerts.map((a) => a.title);
    expect(titles).toEqual([
      "Meta bağlantısı kesildi",
      "Meta bağlantısı kesildi",
      "Meta bağlantısının erişim anahtarının süresi dolmak üzere",
      "Meta reklamı reddetti: Saç ekimi — Taslak (de)",
    ]);
    expect(weekly.unreadAlerts.items.map((a) => a.title)).toEqual(titles.slice(0, 4));
    expect(shell.latestNotifications.map((n) => n.title)).toEqual(titles.slice(0, 4));
  });

  it("türü bilinmeyen başlıklarda kimlik (cuid/uuid) ve telefon maskelenir", () => {
    const shell = sanitizeShellSummary({
      notifications: [{ title: `Bağlantı ${CONN_CUID} için ${PII.phone}`, severity: "INFO" }],
    });
    expect(shell.latestNotifications[0].title).toBe("Bağlantı [kimlik] için [telefon]");
  });
});

describe("sanitize: serbest metin", () => {
  it("e-posta ve telefon maskelenir, metin kısaltılır", () => {
    expect(scrubText(`Ara ${PII.phone} ya da yaz ${PII.email}`)).toBe("Ara [telefon] ya da yaz [e-posta]");
    expect(scrubText("Bütçe 1200 arttı")).toBe("Bütçe 1200 arttı");
    expect(scrubText("x".repeat(500))!.length).toBeLessThanOrEqual(160);
    expect(scrubText(null)).toBeNull();
  });

  it("cuid ve uuid benzeri kimlikler maskelenir; kısa kelimeler ve ref'ler korunur", () => {
    expect(scrubText("Kayıt cm1abc2def3ghi4jkl5mno6pq açık")).toBe("Kayıt [kimlik] açık");
    expect(scrubText("Kayıt CM1ABC2DEF3GHI4JKL5MNO6PQ")).toBe("Kayıt [kimlik]");
    expect(scrubText("id 123e4567-e89b-12d3-a456-426614174000 bitti")).toBe("id [kimlik] bitti");
    expect(scrubText("Kampanya c1 kontrol edildi")).toBe("Kampanya c1 kontrol edildi");
  });
});

describe("sanitize: diğer uçlar", () => {
  it("kabuk özeti kullanıcı adı ve e-postasını taşımaz", () => {
    const out = sanitizeShellSummary({
      user: { name: PII.staff, initials: "DP", role: "OWNER", roleLabel: "Hesap sahibi", workspaceName: "Deneme Klinik" },
      counts: { approvals: 2, leads: 3, alerts: 1 },
      notifications: [{ id: "alert_1", title: `Yeni mesaj ${PII.staffEmail}`, severity: "WARNING", createdAt: "2026-09-30T10:00:00.000Z", href: "/alerts" }],
    });
    expectNoPii(out);
    expect(out).toMatchObject({ pendingApprovals: 2, leadsAwaitingReply: 3, openAlerts: 1, workspace: "Deneme Klinik" });
  });

  it("uyarı gövdesi gönderilmez; başlık maskelenir; kimlik ref'e çevrilir", () => {
    const refs = new RefMap();
    const out = sanitizeAlertList(
      {
        alerts: [
          { id: "alert_secret_1", type: "CONVERSATION_ESCALATED", severity: "CRITICAL", status: "OPEN", title: `Devir: ${PII.phone}`, message: PII.message, entityId: LEAD_ID, createdAt: "2026-09-30T10:00:00.000Z" },
        ],
      },
      refs,
    );
    expectNoPii(out);
    expect(JSON.stringify(out)).not.toContain("alert_secret_1");
    expect(out.alerts[0]).toMatchObject({ ref: "a1", severity: "CRITICAL", title: "Devir: [telefon]" });
  });

  it("kampanya listesi ve ayrıntısı: kimlik yerine ref, para birimi major, hedefleme ve ad set adı yok", () => {
    const refs = new RefMap();
    const campaign = {
      id: "cmp_secret_1", name: "Saç ekimi DE", status: "PAUSED", workflowStatus: "DRAFT", objective: "LEADS",
      dailyBudget: 2500, budgetCents: 2500, currency: "EUR", policyRisk: "LOW", plan: { brief: PII.message },
      adSets: 2, ads: 0, content: { primaryText: PII.message }, review: null, readiness: { ready: false, reasons: ["x"] },
      publish: { status: "NOT_STARTED" }, metaCampaignId: "meta_secret", createdAt: "2026-09-29T00:00:00.000Z",
    };
    const list = sanitizeCampaignList({ campaigns: [campaign, { ...campaign, id: "cmp_secret_2", workflowStatus: "ACTIVE" }] }, refs, { workflowStatus: "ACTIVE" });
    expect(list.total).toBe(1);
    expect(list.byWorkflowStatus).toEqual({ DRAFT: 1, ACTIVE: 1 });
    expect(list.campaigns[0]).toMatchObject({ ref: "c1", dailyBudget: 25, currency: "EUR" });
    const detail = sanitizeCampaignDetail(
      {
        campaign,
        adSets: [{ id: "as_1", name: `${PII.firstName} set`, targeting: { countries: ["DE"] } }],
        metrics: { days7: { spend: 1234, impressions: 10, clicks: 1, leads: 1, purchases: 0 }, days30: { spend: 0 } },
        decisions: [{ id: "dec_1", targetType: "CAMPAIGN", targetId: "cmp_secret_1", action: "PAUSE", approval: "PENDING", reason: `Ara ${PII.phone}`, budgetBefore: 2500, budgetAfter: 2000 }],
      },
      refs,
    );
    const text = JSON.stringify(detail);
    expectNoPii(detail);
    for (const secret of ["cmp_secret_1", "meta_secret", "as_1", "dec_1"]) expect(text).not.toContain(secret);
    expect(detail.metrics.last7Days.spend).toBe(12.34);
    expect(detail.decisions.latest[0]).toMatchObject({ targetRef: "c2", budgetBefore: 25, budgetAfter: 20, reason: "Ara [telefon]" });
  });

  it("öneri, karar, içgörü, haftalık rapor ve abonelik yalnızca beyaz listedeki alanları taşır", () => {
    const refs = new RefMap();
    const recs = sanitizeRecommendationList(
      { recommendations: [{ id: "rec_1", type: "BUDGET_REALLOCATION", status: "PENDING", priority: "HIGH", title: "Bütçeyi kaydır", description: PII.message, reasoning: PII.message, action: { type: "BUDGET_INCREASE" }, evidence: [PII.email] }] },
      refs,
      { status: "PENDING" },
    );
    expectNoPii(recs);
    expect(recs.recommendations[0]).toMatchObject({ ref: "r1", type: "BUDGET_INCREASE" });

    const decisions = sanitizeDecisionList({ decisions: [{ id: "dec_2", targetType: "ADSET", targetId: "as_9", action: "KEEP", approval: "NOT_REQUIRED", reason: "Veri yetersiz", metricsSnapshot: { email: PII.email } }] }, refs);
    expectNoPii(decisions);
    expect(decisions.decisions[0].targetRef).toBeNull();

    const insights = sanitizeInsights(
      {
        currency: "EUR",
        insights: { period: { days: 30 }, summary: { totalSpend: 10000, totalLeads: 5, ctr: 0.012345, cplCents: 2000 }, campaigns: [{ id: "cmp_x", name: "K1", spentCents: 500 }], byCountry: [{ country: "DE", leads: 5, qualified: 2 }], byLanguage: [] },
        alerts: [{ id: "a", title: PII.email }],
        pendingRecommendations: [{ id: "r", description: PII.message }],
      },
      refs,
    );
    expectNoPii(insights);
    expect(insights.summary).toMatchObject({ spend: 100, leads: 5, ctr: 0.0123, cpl: 20 });
    expect(insights.openAlerts).toBe(1);

    const weekly = sanitizeWeeklyReport(
      { report: { period: { start: "2026-09-21T00:00:00.000Z", end: "2026-09-27T23:59:59.999Z" }, summary: { totalSpend: 5000, cpl: 12.5, totalLeads: 4 }, campaigns: [], unreadAlerts: [{ id: "x", severity: "INFO", title: `Not ${PII.email}` }] } },
      refs,
    );
    expectNoPii(weekly);
    expect(weekly.summary).toMatchObject({ spend: 50, cpl: 12.5 });

    const sub = sanitizeSubscription({ subscription: { plan: "PRO", status: "ACTIVE", currentPeriodEnd: "2026-10-31T00:00:00.000Z", cancelAtPeriodEnd: false, stripeManaged: true }, plans: [{ price: 1 }], mock: true });
    expect(sub).toEqual({ subscription: { plan: "PRO", status: "ACTIVE", currentPeriodEnd: "2026-10-31", cancelAtPeriodEnd: false }, demoMode: true });
  });

  it("beklenmeyen biçimde fırlatmaz, alanları düşürür", () => {
    const refs = new RefMap();
    expect(() => sanitizeLeadStats(null, refs)).not.toThrow();
    expect(sanitizeLeadStats({ leads: "x" }, refs).total).toBe(0);
    expect(sanitizeCampaignList(undefined, refs).total).toBe(0);
    expect(sanitizeShellSummary("oops").pendingApprovals).toBe(0);
  });
});

describe("R1 sonuçları (Faz 3)", () => {
  it("kampanya oluşturma ve onaya gönderme: ref ve durum; politika bulgu metni dönmez", () => {
    const refs = new RefMap();
    const created = sanitizeCreatedCampaign(
      { campaign: { id: "cmp_secret_1", name: PII.firstName, workflowStatus: "DRAFT", status: "PAUSED", budgetCents: 2500, currency: "EUR", policyRisk: "MEDIUM", policyWarning: PII.message, adSets: 2 } },
      refs,
    );
    expect(created).toEqual({ ref: "c1", workflowStatus: "DRAFT", status: "PAUSED", dailyBudget: 25, currency: "EUR", policyRisk: "MEDIUM", adSets: 2 });
    const submitted = sanitizeSubmittedCampaign({ campaign: { id: "cmp_secret_1", workflowStatus: "IN_REVIEW", policyRisk: "LOW", policyWarning: PII.message } }, refs);
    expect(submitted).toEqual({ ref: "c1", workflowStatus: "IN_REVIEW", policyRisk: "LOW" });
    expectNoPii([created, submitted]);
    expect(JSON.stringify([created, submitted])).not.toContain("cmp_secret_1");
  });

  it("uyarı güncellemesi: yalnızca ref ve durum (gövde metni yok)", () => {
    const out = sanitizeUpdatedAlert({ ok: true, alert: { id: "alert_secret", status: "RESOLVED", title: "x", message: `${PII.email} ${PII.message}` } }, new RefMap());
    expect(out).toEqual({ ref: "a1", status: "RESOLVED" });
    expectNoPii(out);
  });

  it("üretilen reklam metni: başlık/gövde/CTA maskelenir; profil, form soruları ve WhatsApp metni dönmez", () => {
    const out = sanitizeGeneratedCopy({
      content: {
        clinic: "Deneme Klinik",
        variants: [
          { headline: "Başlık", text: `Bize yazın: ${PII.email} / ${PII.phone}`, cta: "LEARN_MORE" },
          { headline: "Başlık 2", text: "Metin", cta: "LEARN_MORE" },
        ],
        instantForm: { questions: [PII.message, "Soru"] },
        whatsapp: { welcome: PII.message },
        profile: { brandTone: PII.staff, bannedPhrases: [PII.coordinator] },
      },
      policy: { risk: "LOW", findings: [{ reason: PII.message }] },
    });
    expect(out.variants[0]).toEqual({ headline: "Başlık", text: "Bize yazın: [e-posta] / [telefon]", cta: "LEARN_MORE" });
    expect(out).toMatchObject({ instantFormQuestions: 2, whatsappWelcome: true, policyRisk: "LOW" });
    expectNoPii(out);
  });

  it("stüdyo taslağı ve yeniden çekme: ref/durum ve sayılar", () => {
    const draft = sanitizeStudioDraft({ draft: { id: "draft_secret", status: "DRAFT", version: 2, content: { clinic: PII.staff }, policy: { risk: "LOW", reason: PII.message } } }, new RefMap());
    expect(draft).toEqual({ ref: "s1", status: "DRAFT", policyRisk: "LOW" });
    const refetch = sanitizeRefetchSummary({ attempted: 1, recovered: 1, failed: 0, skipped: 0, remaining: 0, results: [{ leadId: LEAD_ID, name: PII.firstName }] });
    expect(refetch).toEqual({ attempted: 1, recovered: 1, failed: 0, skipped: 0, remaining: 0 });
    expectNoPii([draft, refetch]);
    expect(JSON.stringify(refetch)).not.toContain(LEAD_ID);
  });
});
