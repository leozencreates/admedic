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

describe("sanitize: serbest metin", () => {
  it("e-posta ve telefon maskelenir, metin kısaltılır", () => {
    expect(scrubText(`Ara ${PII.phone} ya da yaz ${PII.email}`)).toBe("Ara [telefon] ya da yaz [e-posta]");
    expect(scrubText("Bütçe 1200 arttı")).toBe("Bütçe 1200 arttı");
    expect(scrubText("x".repeat(500))!.length).toBeLessThanOrEqual(160);
    expect(scrubText(null)).toBeNull();
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
