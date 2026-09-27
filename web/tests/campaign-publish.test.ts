import { describe, expect, it, vi } from "vitest";

// Saf yardımcıların testi: veritabanı istemcisi kurulmaz.
vi.mock("@admedic/database", () => ({ prisma: {}, Prisma: {} }));

import { isAdSetBudgetPlan, pushBudgetToMeta, scaleAdSetBudgets, splitEvenly } from "../app/_lib/campaign-budget";
import {
  contentPolicyText,
  deliveryBlockingReason,
  marketCoverage,
  parseCampaignContent,
  parsePlanShape,
  publishReadiness,
  withDeliveryCheck,
  type CampaignContent,
} from "../app/_lib/campaign-content";
import { expectedAdCount, parsePublishState, summarizePublishProgress } from "../app/_lib/campaign-publish";
import { effectiveSpendAuthority } from "../app/_lib/spend-authority";
import { monthlyProjectionCents } from "../app/_lib/spend-cap";
import { decodeAdImage, MAX_AD_IMAGE_BYTES } from "../app/_lib/ad-image";
import { leadFormTexts } from "../app/_lib/lead-form-texts";

const plan = {
  strategy: "ABO",
  conversionMethod: "instant_form",
  adSets: [
    { market: "DE", languages: ["DE", "TR"], dailyBudgetCents: 10_000 },
    { market: "GB", languages: ["EN"], dailyBudgetCents: 10_000 },
  ],
};
const variants = (tag: string) => [
  { headline: `${tag} A`, text: `${tag} metin`, cta: "SIGN_UP" },
  { headline: `${tag} B`, text: `${tag} metin`, cta: "SIGN_UP" },
];
const content: CampaignContent = {
  version: 1,
  attachedAt: "2026-09-27T00:00:00.000Z",
  attachedBy: "user",
  drafts: [
    { draftId: "d-de", draftVersion: 1, name: "DE", language: "DE", service: "Saç", variants: variants("DE"), instantForm: { questions: ["Ne zaman?"] } },
    { draftId: "d-en", draftVersion: 2, name: "EN", language: "EN", service: "Hair", variants: variants("EN") },
  ],
};
const ready = { objective: "MAX_CONVERSIONS", plan, content, imageHash: "hash", privacyPolicyUrl: "https://klinik.example/gizlilik" };

function png(width: number, height: number): string {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}
function jpeg(width: number, height: number): string {
  const buf = Buffer.alloc(40);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).copy(buf, 0);
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]).copy(buf, 20);
  buf.writeUInt16BE(height, 25);
  buf.writeUInt16BE(width, 27);
  return buf.toString("base64");
}

describe("yayın hazırlığı (publishReadiness)", () => {
  it("hazır kampanyada engel yok; içeriği olmayan dil uyarı olarak döner", () => {
    const r = publishReadiness({ ...ready, content: { ...content, drafts: [...content.drafts] } });
    expect(r.reasons).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.delivery).toMatchObject({ objective: "OUTCOME_LEADS", link: "LEAD_FORM", destinationType: "ON_AD" });
    expect(r.warnings.join()).toMatch(/TR dilinde içerik yok/);
  });
  it("plan, içerik, pazar kapsamı, görsel, gizlilik politikası ve açılış sayfası eksiklerini sayar", () => {
    expect(publishReadiness({ ...ready, plan: null }).reasons.join()).toMatch(/planlayıcı/);
    expect(publishReadiness({ ...ready, content: null }).reasons.join()).toMatch(/içeriği bağlanmadı/);
    const onlyDe = { ...content, drafts: [content.drafts[0]!] };
    expect(publishReadiness({ ...ready, content: onlyDe }).reasons.join()).toMatch(/Birleşik Krallık pazarı için onaylı içerik yok/);
    expect(publishReadiness({ ...ready, imageHash: null }).reasons.join()).toMatch(/görseli/);
    expect(publishReadiness({ ...ready, privacyPolicyUrl: null }).reasons.join()).toMatch(/gizlilik politikası/);
    const landing = { ...plan, conversionMethod: "landing_form" };
    expect(publishReadiness({ ...ready, plan: landing }).reasons.join()).toMatch(/açılış sayfası/);
    expect(publishReadiness({ ...ready, plan: landing, content: { ...content, landingUrl: "https://klinik.example" } }).ready).toBe(true);
  });
  it("Meta'da yayınlanamayan hedef × yöntem birleşimlerini reddeder", () => {
    expect(publishReadiness({ ...ready, objective: "MAX_ROAS" }).reasons.join()).toMatch(/Instant Form/);
    expect(deliveryBlockingReason("MAX_IMPRESSIONS", "whatsapp")).toMatch(/WhatsApp/);
    expect(deliveryBlockingReason("MAX_CONVERSIONS", "instagram_dm")).toMatch(/Instagram DM/);
    expect(deliveryBlockingReason("MAX_ROAS", "landing_form")).toBeNull();
    const blocked = withDeliveryCheck({ objective: "MAX_ROAS", conversionMethod: "instant_form", blocked: false, blockingReasons: [] });
    expect(blocked.blocked).toBe(true);
    const fine = { objective: "MAX_CONVERSIONS", conversionMethod: "instant_form", blocked: false, blockingReasons: [] };
    expect(withDeliveryCheck(fine)).toBe(fine);
  });
  it("pazar kapsamı ve plan biçimi", () => {
    const shape = parsePlanShape(plan)!;
    expect(shape).toMatchObject({ strategy: "ABO", conversionMethod: "instant_form" });
    expect(marketCoverage(shape, content)).toEqual([
      { market: "DE", languages: ["DE", "TR"], covered: ["DE"], missing: ["TR"] },
      { market: "GB", languages: ["EN"], covered: ["EN"], missing: [] },
    ]);
    expect(parsePlanShape({ adSets: [] })).toBeNull();
    expect(parseCampaignContent({ version: 2 })).toBeNull();
    expect(contentPolicyText(content)).toContain("Ne zaman?");
  });
});

describe("bütçe dağıtımı (ABO)", () => {
  it("toplamı birebir korur", () => {
    const rows = [
      { id: "a", metaAdSetId: null, dailyBudget: 4500 },
      { id: "b", metaAdSetId: null, dailyBudget: 4500 },
    ];
    expect([...scaleAdSetBudgets(rows, 10_001).values()]).toEqual([5001, 5000]);
    expect([...scaleAdSetBudgets([{ id: "a", metaAdSetId: null, dailyBudget: 1000 }, { id: "b", metaAdSetId: null, dailyBudget: 3000 }], 2000).values()]).toEqual([500, 1500]);
    expect([...scaleAdSetBudgets([{ id: "a", metaAdSetId: null, dailyBudget: null }, { id: "b", metaAdSetId: null, dailyBudget: 0 }], 3).values()]).toEqual([2, 1]);
    expect(splitEvenly(10_001, 3)).toEqual([3334, 3334, 3333]);
    expect(isAdSetBudgetPlan({ strategy: "ABO" })).toBe(true);
    expect(isAdSetBudgetPlan(null)).toBe(false);
  });
  it("CBO kampanyaya, ABO yayındaki ad set'lere yazar; ad set yoksa Meta'ya dokunmaz", async () => {
    const updateBudget = vi.fn().mockResolvedValue({ success: true });
    const meta = { updateBudget };
    const cbo = await pushBudgetToMeta({ meta, token: "t", metaCampaignId: "c1", plan: { strategy: "CBO" }, adSets: [], newDailyCents: 30_000 });
    expect(cbo.level).toBe("campaign");
    expect(updateBudget).toHaveBeenCalledWith({ entityType: "campaign", entityId: "c1", dailyBudgetCents: 30_000 }, "t");
    updateBudget.mockClear();
    const abo = await pushBudgetToMeta({
      meta, token: "t", metaCampaignId: "c1", plan: { strategy: "ABO" }, newDailyCents: 30_000,
      adSets: [{ id: "a", metaAdSetId: "m-a", dailyBudget: 10_000 }, { id: "b", metaAdSetId: "m-b", dailyBudget: 10_000 }],
    });
    expect(abo.level).toBe("adset");
    expect(updateBudget.mock.calls.map(([arg]) => arg)).toEqual([
      { entityType: "adset", entityId: "m-a", dailyBudgetCents: 15_000 },
      { entityType: "adset", entityId: "m-b", dailyBudgetCents: 15_000 },
    ]);
    updateBudget.mockClear();
    const none = await pushBudgetToMeta({ meta, token: "t", metaCampaignId: "c1", plan: { strategy: "ABO" }, newDailyCents: 5, adSets: [{ id: "a", metaAdSetId: null, dailyBudget: 1 }] });
    expect(none.level).toBe("none");
    expect(updateBudget).not.toHaveBeenCalled();
  });
  it("ABO'da bir ad set başarısız olursa öncekileri eski bütçeye geri alır ve hatayı iletir", async () => {
    const updateBudget = vi.fn()
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error("Meta down"))
      .mockResolvedValue({ success: true });
    await expect(pushBudgetToMeta({
      meta: { updateBudget }, token: "t", metaCampaignId: "c1", plan: { strategy: "ABO" }, newDailyCents: 40_000,
      adSets: [{ id: "a", metaAdSetId: "m-a", dailyBudget: 10_000 }, { id: "b", metaAdSetId: "m-b", dailyBudget: 10_000 }],
    })).rejects.toThrow("Meta down");
    expect(updateBudget.mock.calls.map(([arg]) => arg)).toEqual([
      { entityType: "adset", entityId: "m-a", dailyBudgetCents: 20_000 },
      { entityType: "adset", entityId: "m-b", dailyBudgetCents: 20_000 },
      { entityType: "adset", entityId: "m-a", dailyBudgetCents: 10_000 },
    ]);
  });
  it("aylık projeksiyon: günlük × 30, ömür boyu bütçe tamamı", () => {
    expect(monthlyProjectionCents({ dailyBudget: 1000, lifetimeBudget: null, budgetType: "DAILY" })).toBe(30_000);
    expect(monthlyProjectionCents({ dailyBudget: null, lifetimeBudget: 50_000, budgetType: "LIFETIME" })).toBe(50_000);
    expect(monthlyProjectionCents({ dailyBudget: null, lifetimeBudget: null, budgetType: null })).toBe(0);
  });
});

describe("harcama yetkisi", () => {
  it("Owner her zaman; ADMIN/MEDIA_BUYER yalnızca yetki verilmişse; diğer roller ve pasif üyeler asla", () => {
    expect(effectiveSpendAuthority({ role: "OWNER", status: "ACTIVE", canApproveSpend: false })).toBe(true);
    expect(effectiveSpendAuthority({ role: "OWNER", status: "DISABLED", canApproveSpend: true })).toBe(false);
    expect(effectiveSpendAuthority({ role: "ADMIN", status: "ACTIVE", canApproveSpend: false })).toBe(false);
    expect(effectiveSpendAuthority({ role: "ADMIN", status: "ACTIVE", canApproveSpend: true })).toBe(true);
    expect(effectiveSpendAuthority({ role: "MEDIA_BUYER", status: "ACTIVE", canApproveSpend: true })).toBe(true);
    expect(effectiveSpendAuthority({ role: "VIEWER", status: "ACTIVE", canApproveSpend: true })).toBe(false);
    expect(effectiveSpendAuthority({ role: "PATIENT_COORDINATOR", status: "ACTIVE", canApproveSpend: true })).toBe(false);
  });
});

describe("yayın ilerlemesi", () => {
  it("beklenen reklam sayısı ad set dili × taslak varyantlarıdır", () => {
    const rows = [
      { metaAdSetId: "x", targeting: { language: "DE" } },
      { metaAdSetId: null, targeting: { languages: ["EN", "TR"] } },
    ];
    expect(expectedAdCount(rows, content)).toBe(4);
    const p = summarizePublishProgress({ metaCampaignId: "c", workflowStatus: "APPROVED", publishState: { version: 1, leadForms: { a: "f" }, creatives: { "a:0": "c" }, locales: {} }, content, adSets: rows, publishedAds: 1 });
    expect(p).toMatchObject({ status: "IN_PROGRESS", campaignCreated: true, adSets: { total: 2, published: 1 }, ads: { expected: 4, published: 1 }, leadForms: 1, creatives: 1 });
    const base = { publishState: null, content: null, adSets: [], publishedAds: 0 };
    expect(summarizePublishProgress({ ...base, metaCampaignId: null, workflowStatus: "DRAFT" }).status).toBe("NOT_STARTED");
    // Meta'dan senkronlanan / eski akışla yayınlanan kampanya: tam yayın akışının dışında.
    expect(summarizePublishProgress({ ...base, metaCampaignId: "m", workflowStatus: "ACTIVE" }).status).toBe("EXTERNAL");
    expect(summarizePublishProgress({ ...base, metaCampaignId: "m", workflowStatus: "APPROVED" }).status).toBe("IN_PROGRESS");
  });
  it("bozuk yayın durumu yok sayılır, geçerli olan normalize edilir", () => {
    expect(parsePublishState({ version: 2 })).toBeNull();
    expect(parsePublishState({ version: 1, locales: { DE: [5, "x"] }, completedAt: "t", lastError: { step: "ads", message: "m" } })).toMatchObject({
      locales: { DE: [5] }, leadForms: {}, creatives: {}, completedAt: "t", lastError: { step: "ads", message: "m" },
    });
  });
});

describe("reklam görseli", () => {
  it("PNG/JPEG'i sihirli baytlardan tanır, boyutu okur, küçük görselde uyarır", () => {
    const big = decodeAdImage({ filename: "Görsel 1.PNG", dataBase64: `data:image/png;base64,${png(1200, 1200)}` });
    expect(big).toMatchObject({ type: "image/png", width: 1200, height: 1200, filename: "G-rsel-1.png", warnings: [] });
    const small = decodeAdImage({ filename: "a.jpg", dataBase64: jpeg(800, 600) });
    expect(small).toMatchObject({ type: "image/jpeg", width: 800, height: 600 });
    expect(small.warnings.join()).toMatch(/1080/);
  });
  it("desteklenmeyen tür, bozuk base64 ve sınırı aşan boyut reddedilir", () => {
    const gif = Buffer.from("GIF89a-----------------").toString("base64");
    expect(() => decodeAdImage({ filename: "a.gif", dataBase64: gif })).toThrow(/JPEG veya PNG/);
    expect(() => decodeAdImage({ filename: "a.png", dataBase64: "!!!!not-base64!!!!" })).toThrow(/base64/);
    const huge = Buffer.alloc(MAX_AD_IMAGE_BYTES + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(huge, 0);
    expect(() => decodeAdImage({ filename: "a.png", dataBase64: huge.toString("base64") })).toThrow(/en fazla/);
  });
});

describe("Instant Form rıza metinleri", () => {
  it("Türkçe formda kuruluş metni kullanılır; diğer dillerde yerel genel metin; başlıklar Meta sınırında", () => {
    expect(leadFormTexts("TR", "Kurum aydınlatma metni").body).toBe("Kurum aydınlatma metni");
    expect(leadFormTexts("DE", "Kurum aydınlatma metni").body).toMatch(/Datenschutzerklärung/);
    for (const lang of ["TR", "EN", "DE", "RU", "AR", "FR", "NL", "PL"] as const)
      expect(leadFormTexts(lang).title.length).toBeLessThanOrEqual(60);
  });
});
