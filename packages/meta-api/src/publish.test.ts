import { describe, expect, it } from "vitest";

import {
  buildAdBody,
  buildAdCreativeBody,
  buildAdSetBody,
  buildLeadFormBody,
  buildTargeting,
  LEAD_AD_LINK,
  LEAD_FORM_CONSENT_KEY,
  MetaPublishSpecError,
  pickLocaleKeys,
  resolveDelivery,
  WHATSAPP_AD_LINK,
} from "./publish";

describe("resolveDelivery (objective × dönüşüm yöntemi)", () => {
  it("Instant Form yalnızca OUTCOME_LEADS + ON_AD + LEAD_GENERATION", () => {
    expect(resolveDelivery("MAX_CONVERSIONS", "instant_form")).toEqual({
      objective: "OUTCOME_LEADS",
      destinationType: "ON_AD",
      optimizationGoal: "LEAD_GENERATION",
      billingEvent: "IMPRESSIONS",
      link: "LEAD_FORM",
      promotesPage: true,
    });
    expect(() => resolveDelivery("MAX_ROAS", "instant_form")).toThrow(MetaPublishSpecError);
    expect(() => resolveDelivery("MAX_IMPRESSIONS", "instant_form")).toThrow(/Potansiyel müşteri/);
  });

  it("WhatsApp: CONVERSATIONS + WHATSAPP; bilinirlik hedefiyle reddedilir", () => {
    expect(resolveDelivery("MAX_CONVERSIONS", "whatsapp")).toMatchObject({
      destinationType: "WHATSAPP",
      optimizationGoal: "CONVERSATIONS",
      link: "WHATSAPP",
      promotesPage: true,
    });
    expect(resolveDelivery("MAX_ROAS", "whatsapp").objective).toBe("OUTCOME_SALES");
    expect(() => resolveDelivery("MAX_IMPRESSIONS", "whatsapp")).toThrow(MetaPublishSpecError);
  });

  it("açılış sayfası: sağlık kısıtı nedeniyle LINK_CLICKS; bilinirlikte REACH ve destination_type yok", () => {
    expect(resolveDelivery("MAX_CONVERSIONS", "landing_form")).toMatchObject({
      destinationType: "WEBSITE",
      optimizationGoal: "LINK_CLICKS",
      link: "WEBSITE",
      promotesPage: false,
    });
    const awareness = resolveDelivery("MAX_IMPRESSIONS", "landing_form");
    expect(awareness).toMatchObject({ objective: "OUTCOME_AWARENESS", optimizationGoal: "REACH" });
    expect(awareness).not.toHaveProperty("destinationType");
  });

  it("Instagram DM ve bilinmeyen değerler Meta'ya gitmeden reddedilir", () => {
    expect(() => resolveDelivery("MAX_CONVERSIONS", "instagram_dm")).toThrow(/Instagram mesajına/);
    expect(() => resolveDelivery("CONVERSIONS", "instant_form")).toThrow(/Desteklenmeyen kampanya hedefi/);
    expect(() => resolveDelivery("MAX_CONVERSIONS", "sms")).toThrow(/Bilinmeyen dönüşüm yöntemi/);
    const error = (() => {
      try {
        resolveDelivery("MAX_CONVERSIONS", "instagram_dm");
      } catch (e) {
        return e as MetaPublishSpecError;
      }
    })();
    expect(error?.status).toBe(422);
  });
});

describe("hedefleme ve locale seçimi", () => {
  it("18 yaş altı ve boş ülke reddedilir; yaş üst sınırı 65'e kırpılır; locale yalnızca varsa eklenir", () => {
    expect(buildTargeting({ countries: ["de", "DE", "xx1"], localeKeys: [5, 5, 0], ageMin: 25, ageMax: 70 })).toEqual({
      geo_locations: { countries: ["DE"] },
      age_min: 25,
      age_max: 65,
      locales: [5],
    });
    expect(buildTargeting({ countries: ["TR"], localeKeys: [], ageMin: 18, ageMax: 54 })).not.toHaveProperty("locales");
    expect(() => buildTargeting({ countries: ["TR"], localeKeys: [], ageMin: 17, ageMax: 54 })).toThrow(/18 yaş/);
    expect(() => buildTargeting({ countries: [], localeKeys: [], ageMin: 18, ageMax: 54 })).toThrow(/ülke/);
    expect(() => buildTargeting({ countries: ["TR"], localeKeys: [], ageMin: 40, ageMax: 30 })).toThrow(/Alt yaş/);
  });

  it("\"(All)\" locale'i tercih edilir, şaka locale'ler atılır, bölgesel varyantlara düşülür", () => {
    expect(
      pickLocaleKeys("EN", [
        { key: 6, name: "English (US)" },
        { key: 1001, name: "English (All)" },
        { key: 51, name: "English (Upside Down)" },
      ]),
    ).toEqual([1001]);
    expect(pickLocaleKeys("TR", [{ key: 19, name: "Turkish" }])).toEqual([19]);
    expect(
      pickLocaleKeys("NL", [
        { key: 34, name: "Dutch (België)" },
        { key: 51, name: "English (Upside Down)" },
      ]),
    ).toEqual([34]);
    expect(pickLocaleKeys("PL", [])).toEqual([]);
  });
});

describe("istek gövdeleri", () => {
  const leadDelivery = resolveDelivery("MAX_CONVERSIONS", "instant_form");

  it("ad set: her zaman PAUSED; ABO'da bütçe + teklif stratejisi, CBO'da ikisi de yok", () => {
    const abo = buildAdSetBody({
      campaignId: "c1",
      name: "Almanya · DE/TR",
      delivery: leadDelivery,
      targeting: { countries: ["DE"], localeKeys: [5, 19], ageMin: 25, ageMax: 54 },
      dailyBudgetCents: 4500,
      pageId: "p1",
    });
    expect(abo).toMatchObject({
      campaign_id: "c1",
      status: "PAUSED",
      billing_event: "IMPRESSIONS",
      optimization_goal: "LEAD_GENERATION",
      destination_type: "ON_AD",
      daily_budget: 4500,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    });
    expect(JSON.parse(String(abo.promoted_object))).toEqual({ page_id: "p1" });
    expect(JSON.parse(String(abo.targeting))).toEqual({
      geo_locations: { countries: ["DE"] },
      age_min: 25,
      age_max: 54,
      locales: [5, 19],
    });
    const cbo = buildAdSetBody({
      campaignId: "c1",
      name: "x",
      delivery: resolveDelivery("MAX_CONVERSIONS", "landing_form"),
      targeting: { countries: ["GB"], localeKeys: [], ageMin: 18, ageMax: 54 },
    });
    expect(cbo).not.toHaveProperty("daily_budget");
    expect(cbo).not.toHaveProperty("bid_strategy");
    expect(cbo).not.toHaveProperty("promoted_object");
    expect(() =>
      buildAdSetBody({ campaignId: "c1", name: "x", delivery: leadDelivery, targeting: { countries: ["DE"], localeKeys: [], ageMin: 18, ageMax: 54 } }),
    ).toThrow(/Sayfası/);
  });

  it("lead reklamı kreatifi: fb.me bağlantısı, form kimliği, izinli CTA; metni değiştiren özellikler kapalı", () => {
    const body = buildAdCreativeBody({
      name: "K · DE · A",
      pageId: "p1",
      delivery: leadDelivery,
      imageHash: "h1",
      headline: "Başlık",
      text: "Metin",
      description: "Açıklama",
      cta: "BOOK_NOW",
      leadFormId: "f1",
    });
    const spec = JSON.parse(String(body.object_story_spec));
    expect(spec).toEqual({
      page_id: "p1",
      link_data: {
        name: "Başlık",
        message: "Metin",
        description: "Açıklama",
        link: LEAD_AD_LINK,
        image_hash: "h1",
        call_to_action: { type: "LEARN_MORE", value: { lead_gen_form_id: "f1" } },
      },
    });
    const dof = JSON.parse(String(body.degrees_of_freedom_spec));
    expect(dof.creative_features_spec.text_optimizations).toEqual({ enroll_status: "OPT_OUT" });
    expect(Object.keys(dof.creative_features_spec)).not.toContain("standard_enhancements");
    const signUp = JSON.parse(
      String(
        buildAdCreativeBody({ name: "x", pageId: "p1", delivery: leadDelivery, imageHash: "h", headline: "h", text: "t", cta: "sign_up", leadFormId: "f" })
          .object_story_spec,
      ),
    );
    expect(signUp.link_data.call_to_action.type).toBe("SIGN_UP");
    expect(() =>
      buildAdCreativeBody({ name: "x", pageId: "p1", delivery: leadDelivery, imageHash: "h", headline: "h", text: "t", cta: "SIGN_UP" }),
    ).toThrow(/Lead formu/);
    expect(() =>
      buildAdCreativeBody({ name: "x", pageId: "p1", delivery: leadDelivery, imageHash: "", headline: "h", text: "t", cta: "SIGN_UP", leadFormId: "f" }),
    ).toThrow(/görseli/);
  });

  it("WhatsApp ve web kreatifleri doğru bağlantı ve CTA'yı kullanır", () => {
    const wa = JSON.parse(
      String(
        buildAdCreativeBody({
          name: "x",
          pageId: "p1",
          delivery: resolveDelivery("MAX_CONVERSIONS", "whatsapp"),
          imageHash: "h",
          headline: "h",
          text: "t",
          cta: "LEARN_MORE",
        }).object_story_spec,
      ),
    );
    expect(wa.link_data.link).toBe(WHATSAPP_AD_LINK);
    expect(wa.link_data.call_to_action).toEqual({ type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } });
    const web = JSON.parse(
      String(
        buildAdCreativeBody({
          name: "x",
          pageId: "p1",
          delivery: resolveDelivery("MAX_CONVERSIONS", "landing_form"),
          imageHash: "h",
          headline: "h",
          text: "t",
          cta: "BOOK_NOW",
          landingUrl: "https://klinik.example/sac-ekimi",
        }).object_story_spec,
      ),
    );
    expect(web.link_data.link).toBe("https://klinik.example/sac-ekimi");
    expect(web.link_data.call_to_action).toEqual({ type: "BOOK_NOW", value: { link: "https://klinik.example/sac-ekimi" } });
  });

  it("reklam her zaman PAUSED ve kreatif kimliğini JSON olarak taşır", () => {
    expect(buildAdBody({ name: "Reklam", adSetId: "as1", creativeId: "cr1" })).toEqual({
      name: "Reklam",
      adset_id: "as1",
      creative: JSON.stringify({ creative_id: "cr1" }),
      status: "PAUSED",
    });
  });

  it("lead formu: standart sorular + özel sorular, https gizlilik politikası, zorunlu rıza kutusu", () => {
    const body = buildLeadFormBody({
      name: "Form · DE",
      language: "DE",
      customQuestions: ["Welche Behandlung interessiert Sie?", " ", "Wann möchten Sie reisen?"],
      privacyPolicyUrl: "https://klinik.example/datenschutz",
      privacyLinkText: "Datenschutz",
      consent: { title: "Einwilligung", body: "Ihre Daten werden verarbeitet.", checkboxText: "Ich stimme zu" },
    });
    expect(body.locale).toBe("DE_DE");
    expect(JSON.parse(String(body.questions))).toEqual([
      { type: "FULL_NAME" },
      { type: "PHONE" },
      { type: "EMAIL" },
      { type: "CUSTOM", key: "question_1", label: "Welche Behandlung interessiert Sie?" },
      { type: "CUSTOM", key: "question_2", label: "Wann möchten Sie reisen?" },
    ]);
    expect(JSON.parse(String(body.privacy_policy))).toEqual({ url: "https://klinik.example/datenschutz", link_text: "Datenschutz" });
    const disclaimer = JSON.parse(String(body.custom_disclaimer));
    expect(disclaimer.checkboxes).toEqual([
      { key: LEAD_FORM_CONSENT_KEY, text: "Ich stimme zu", is_required: true, is_checked_by_default: false },
    ]);
    expect(() =>
      buildLeadFormBody({
        name: "x",
        language: "TR",
        customQuestions: [],
        privacyPolicyUrl: "http://klinik.example/gizlilik",
        privacyLinkText: "Gizlilik",
        consent: { title: "t", body: "b", checkboxText: "c" },
      }),
    ).toThrow(/https/);
  });
});
