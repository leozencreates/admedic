export type PlanObjective = "MAX_ROAS" | "MAX_CONVERSIONS" | "MAX_IMPRESSIONS";
export const PLAN_OBJECTIVES = ["MAX_ROAS", "MAX_CONVERSIONS", "MAX_IMPRESSIONS"] as const;

/** Dönüşüm yöntemi (spec 3.3: Instant Form / Click-to-WhatsApp / landing page + Instagram DM). */
export type ConversionMethod = "landing_form" | "instant_form" | "whatsapp" | "instagram_dm";
export const CONVERSION_METHODS = ["landing_form", "instant_form", "whatsapp", "instagram_dm"] as const;

export type BudgetStrategy = "CBO" | "ABO";

/** Planlayıcı tarafından üretilebilecek en fazla ad set sayısı (pazar başına 1). */
export const MAX_PLAN_AD_SETS = 3;

export interface CampaignPlanInput {
  objective: PlanObjective;
  /** Günlük bütçe — minor unit (cent/kuruş). */
  dailyBudgetCents: number;
  /** Kuruluş aylık üst sınırı — minor unit. */
  monthlyCapCents?: number;
  markets: string[];
  ageMin?: number;
  ageMax?: number;
  languages: string[];
  conversionMethod: ConversionMethod;
  /** Kullanıcı CBO/ABO'yu elle seçebilir; verilmezse bütçe stratejisi otomatik türetilir. */
  strategy?: BudgetStrategy;
  /** Doğal dilde reklam hedefi (serbest metin; plan kaydına işlenir). */
  brief?: string;
  /** Klinik pazar hedeflerinden (MarketTarget) gelen ülke → diller; varsayılan haritayı ezer. */
  marketLanguageOverrides?: Record<string, string[]>;
  /** Reklam hesabının para birimi (ISO 4217); metinlerde gösterim için. */
  currency?: string;
}

export interface PlanAdSet {
  name: string;
  /** Planlayıcı pazar anahtarı (DE, GB, GULF, ...). */
  market: string;
  /** Ad set'in reklam dilleri (uygulama dil kodları: TR, EN, DE, ...). */
  languages: string[];
  /** ABO'da bütçe payı (cent); CBO'da null (bütçe kampanya seviyesinde). */
  dailyBudgetCents: number | null;
  /**
   * Meta ad set hedefleme taslağı. `locales` uygulama dil kodlarıdır; Meta'nın sayısal
   * locale kimliklerine çeviri ad set Meta'ya gönderilirken yapılır.
   */
  targeting: {
    geo_locations: { countries: string[] };
    locales: string[];
    age_min: number;
    age_max: number;
  };
}

/** Her öneri "neden" açıklamasıyla gelir (spec 3.3 kabul kriteri). */
export interface PlanReasons {
  objective: string;
  targeting: string;
  conversionMethod: string;
  testPlan: string;
  strategy: string;
}

export interface CampaignPlan {
  name: string;
  objective: PlanObjective;
  dailyBudgetCents: number;
  monthlyProjectedCents: number;
  currency: string;
  structure: string;
  strategy: BudgetStrategy;
  /** = reasons.strategy (geri uyumluluk). */
  rationale: string;
  /** = reasons.targeting (geri uyumluluk). */
  targetingRationale: string;
  conversionMethod: ConversionMethod;
  markets: string[];
  languages: string[];
  ageMin: number;
  ageMax: number;
  /** Kullanıcının doğal dil hedefi (politika kontrolüne de beslenir). */
  brief?: string;
  adSets: PlanAdSet[];
  reasons: PlanReasons;
  blocked: boolean;
  blockingReasons: string[];
  testPlan: {
    creativeVariations: number;
    testDurationDays: number;
    decisionMetric: string;
  };
}

const OBJECTIVE_LABEL: Record<PlanObjective, string> = {
  MAX_ROAS: "Maks. ROAS",
  MAX_CONVERSIONS: "Maks. Dönüşüm",
  MAX_IMPRESSIONS: "Maks. Görüntüleme",
};

const OBJECTIVE_REASON: Record<PlanObjective, string> = {
  MAX_ROAS:
    "Satış/ciro odaklı hedef: Meta OUTCOME_SALES ile dönüşüm değeri en yüksek kitleye optimize edilir; yüksek paket değerli tedavilerde ROAS ölçülebilir olduğundan seçildi.",
  MAX_CONVERSIONS:
    "Lead odaklı hedef: Meta OUTCOME_LEADS, form/WhatsApp başvurusu yapma olasılığı en yüksek kullanıcılara teslim eder; sağlık turizminde ana dönüşüm konsültasyon talebidir.",
  MAX_IMPRESSIONS:
    "Bilinirlik odaklı hedef: Meta OUTCOME_AWARENESS, pazara yeni giren klinik için erişim ve frekansla ilk teması kurar; lead beklentisi bu aşamada düşük tutulur.",
};

export const METHOD_LABEL: Record<ConversionMethod, string> = {
  landing_form: "Açılış Sayfası",
  instant_form: "Instant Form",
  whatsapp: "WhatsApp",
  instagram_dm: "Instagram DM",
};

const METHOD_REASON: Record<ConversionMethod, string> = {
  landing_form:
    "Açılış sayfası formu: aydınlatma/rıza metni ve ön eleme soruları sizin kontrolünüzde; Instant Form'a göre daha düşük hacim, daha nitelikli lead.",
  instant_form:
    "Instant Form (Meta Lead Ads): uygulama içinde doldurulduğu için sürtünme en düşük, lead hacmi en yüksek; rıza metni ve ön eleme soruları forma eklenir (spec 3.11).",
  whatsapp:
    "Click-to-WhatsApp: Körfez ve Rusça konuşan pazarlarda tercih edilen kanal; AI karşılama asistanı ilk yanıtı verir, 24 saatlik mesajlaşma penceresi kuralına uyulur.",
  instagram_dm:
    "Instagram DM: görsel ağırlıklı hizmetlerde (estetik, diş) genç kitlede etkileşim yüksek; koordinatör devri için DM otomasyonu gerekir.",
};

/**
 * Pazar (ülke) → reklam dilleri (spec 3.2: Almanya → DE/TR, İngiltere → EN,
 * Rusya/Kazakistan → RU, Körfez → AR/EN). Klinik MarketTarget kayıtları varsa
 * `marketLanguageOverrides` ile bu harita ezilir.
 */
export const COUNTRY_LANGUAGE_MAP: Record<string, string[]> = {
  DE: ["DE", "TR"],
  GB: ["EN"],
  RU: ["RU"],
  KZ: ["RU"],
  GULF: ["AR", "EN"],
  FR: ["FR"],
  NL: ["NL"],
  PL: ["PL"],
  TR: ["TR"],
  USA: ["EN"],
  US: ["EN"],
  NETHERLANDS: ["NL"],
  FRANCE: ["FR"],
  POLAND: ["PL"],
};

/** Planlayıcı pazar anahtarı → ISO 3166-1 alpha-2 ülke kodları (Meta `geo_locations.countries`). */
export const MARKET_COUNTRIES: Record<string, string[]> = {
  DE: ["DE"],
  TR: ["TR"],
  RU: ["RU"],
  KZ: ["KZ"],
  GB: ["GB"],
  GULF: ["AE", "SA", "QA", "KW", "BH", "OM"],
  USA: ["US"],
  US: ["US"],
  NETHERLANDS: ["NL"],
  NL: ["NL"],
  FRANCE: ["FR"],
  FR: ["FR"],
  POLAND: ["PL"],
  PL: ["PL"],
};

export const PLANNER_MARKETS: Record<string, string> = {
  DE: "Almanya",
  TR: "Türkiye",
  RU: "Rusya",
  KZ: "Kazakistan",
  GB: "Birleşik Krallık",
  GULF: "Körfez",
  USA: "ABD",
  NETHERLANDS: "Hollanda",
  FRANCE: "Fransa",
  POLAND: "Polonya",
};

/** WhatsApp'ın birincil kanal olduğu pazarlar (öneri metni için). */
const WHATSAPP_FIRST_MARKETS = new Set(["GULF", "RU", "KZ"]);

export function marketCountries(market: string): string[] {
  const key = market.toUpperCase();
  const mapped = MARKET_COUNTRIES[key];
  if (mapped) return mapped;
  return /^[A-Z]{2}$/.test(key) ? [key] : [];
}

export function marketLanguagesFor(
  market: string,
  overrides?: Record<string, string[]>,
): string[] {
  const key = market.toUpperCase();
  const override = overrides?.[key];
  if (override && override.length > 0) return override;
  return COUNTRY_LANGUAGE_MAP[key] ?? ["EN"];
}

export function marketLanguages(
  markets: string[],
  overrides?: Record<string, string[]>,
): string[] {
  const langs = new Set<string>();
  for (const m of markets) {
    for (const l of marketLanguagesFor(m, overrides)) langs.add(l);
  }
  return langs.size > 0 ? Array.from(langs) : ["EN"];
}

export function formatPlanMoney(cents: number, currency: string): string {
  const major = cents / 100;
  const text = Number.isInteger(major)
    ? major.toLocaleString("tr-TR")
    : major.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${text} ${currency}`;
}

function splitBudget(totalCents: number, parts: number): number[] {
  const base = Math.floor(totalCents / parts);
  const remainder = totalCents % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

export function buildCampaignPlan(input: CampaignPlanInput): CampaignPlan {
  const blockingReasons: string[] = [];
  const currency = input.currency ?? "EUR";
  const ageMin = input.ageMin ?? 18;
  const ageMax = input.ageMax ?? 54;
  const markets = Array.from(new Set(input.markets.map((m) => m.toUpperCase())));
  if (ageMin < 18 || ageMax < 18)
    blockingReasons.push(
      `18 yaş altı hedefleme engellenir (girilen aralık ${ageMin}-${ageMax}); Meta sağlık reklamlarında alt sınır 18'dir.`,
    );
  if (ageMin > ageMax)
    blockingReasons.push("Alt yaş sınırı üst yaş sınırını aşamaz.");
  if (!markets.length)
    blockingReasons.push("En az bir pazar (ülke) seçilmelidir.");
  if (!Number.isFinite(input.dailyBudgetCents) || input.dailyBudgetCents <= 0)
    blockingReasons.push("Günlük bütçe pozitif bir değer olmalıdır.");
  const monthlyProjectedCents = Math.round(input.dailyBudgetCents * 30);
  if (input.monthlyCapCents != null && monthlyProjectedCents > input.monthlyCapCents)
    blockingReasons.push(
      `Aylık öngörülen bütçe (${formatPlanMoney(monthlyProjectedCents, currency)}) kuruluş üst sınırını (${formatPlanMoney(input.monthlyCapCents, currency)}) aşıyor.`,
    );

  const mainMarket = markets[0] ?? "belirsiz";
  const marketCount = markets.length;
  const overrides = input.marketLanguageOverrides;
  const usedClinicTargets = markets.some((m) => (overrides?.[m]?.length ?? 0) > 0);
  const explicitLangs = Array.from(new Set(input.languages.map((l) => l.toUpperCase())));
  const campaignLangs =
    explicitLangs.length > 0 ? explicitLangs : marketLanguages(markets, overrides);
  const label = OBJECTIVE_LABEL[input.objective];
  const name = `${label} — ${PLANNER_MARKETS[mainMarket] ?? mainMarket}`;

  const strategy: BudgetStrategy =
    input.strategy ?? (marketCount > 1 || campaignLangs.length > 1 ? "CBO" : "ABO");

  // Pazar/dil başına 1 ad set (en fazla MAX_PLAN_AD_SETS).
  const adSetMarkets = markets.slice(0, MAX_PLAN_AD_SETS);
  const shares =
    strategy === "ABO" && adSetMarkets.length > 0
      ? splitBudget(Math.max(0, Math.round(input.dailyBudgetCents)), adSetMarkets.length)
      : [];
  const adSets: PlanAdSet[] = adSetMarkets.map((market, i) => {
    const marketLangs = marketLanguagesFor(market, overrides);
    const filtered =
      explicitLangs.length > 0 ? marketLangs.filter((l) => explicitLangs.includes(l)) : marketLangs;
    const languages = filtered.length > 0 ? filtered : explicitLangs.length > 0 ? explicitLangs : marketLangs;
    return {
      name: `${PLANNER_MARKETS[market] ?? market} · ${languages.join("/")}`,
      market,
      languages,
      dailyBudgetCents: strategy === "ABO" ? (shares[i] ?? 0) : null,
      targeting: {
        geo_locations: { countries: marketCountries(market) },
        locales: languages,
        age_min: ageMin,
        age_max: ageMax,
      },
    };
  });

  const strategyReason =
    strategy === "CBO"
      ? `${marketCount} pazar / ${campaignLangs.length} dil tek bütçeli kampanyada (CBO) birleştirilir; Meta, günlük bütçeyi en iyi CPL üreten ad set'e otomatik dağıtır ve küçük pazarlar bütçesiz kalmaz.`
      : `${marketCount} pazar / ${campaignLangs.length} dil için ad set bazlı bütçe (ABO): her pazar sabit pay alır, hedefleme hassasiyeti ve pazar başına harcama kontrolü korunur.`;

  const marketText = adSetMarkets
    .map((m) => `${PLANNER_MARKETS[m] ?? m} (${marketLanguagesFor(m, overrides).join("/")})`)
    .join(", ");
  const targetingReason =
    `${ageMin}-${ageMax} yaş; pazarlar: ${marketText}${markets.length > MAX_PLAN_AD_SETS ? ` (+${markets.length - MAX_PLAN_AD_SETS} pazar ikinci kampanyaya bırakıldı)` : ""}. ` +
    `Diller ${usedClinicTargets ? "klinik pazar hedeflerinden" : "pazar-dil haritasından"} türetildi${explicitLangs.length > 0 ? ", seçtiğiniz dillerle kesiştirildi" : ""}; ` +
    "18 yaş altı hariç tutulur (Meta sağlık reklam kuralı) ve kişisel özellik varsayımı içeren hedefleme kullanılmaz.";

  const whatsappHint =
    input.conversionMethod !== "whatsapp" && adSetMarkets.some((m) => WHATSAPP_FIRST_MARKETS.has(m))
      ? " Seçilen pazarlarda WhatsApp birincil kanal olduğundan Click-to-WhatsApp varyantı da değerlendirin."
      : "";
  const conversionReason = METHOD_REASON[input.conversionMethod] + whatsappHint;

  const testDurationDays = marketCount > 1 ? 7 : 14;
  const creativeVariations = 3; // 1 kontrol + 2 varyant
  const decisionMetric = "CPL / lead sayısı";
  const testPlanReason =
    `Her ad set'te 1 kontrol + 2 varyant kreatif (${creativeVariations} varyasyon) ${testDurationDays} gün yayınlanır; ` +
    `karar metriği ${decisionMetric}: ${strategy === "CBO" ? "CBO'da Meta dağıtımı farklı olsa da" : "ABO'da bütçe payları eşit olduğundan"} lead başına maliyet ve lead sayısı kıyaslanır, kazanan varyant ölçeklenir.`;

  const structure =
    `${strategy} — ${adSets.length} ad set (pazar başına: ${adSetMarkets.map((m) => PLANNER_MARKETS[m] ?? m).join(", ") || "—"}), ` +
    `her ad set'te 1 kontrol + 2 varyant kreatif, diller ${campaignLangs.join(", ")}, dönüşüm ${METHOD_LABEL[input.conversionMethod]}`;

  const reasons: PlanReasons = {
    objective: OBJECTIVE_REASON[input.objective],
    targeting: targetingReason,
    conversionMethod: conversionReason,
    testPlan: testPlanReason,
    strategy: strategyReason,
  };

  return {
    name,
    objective: input.objective,
    dailyBudgetCents: input.dailyBudgetCents,
    monthlyProjectedCents,
    currency,
    structure,
    strategy,
    rationale: reasons.strategy,
    targetingRationale: reasons.targeting,
    conversionMethod: input.conversionMethod,
    markets,
    languages: campaignLangs,
    ageMin,
    ageMax,
    ...(input.brief?.trim() ? { brief: input.brief.trim() } : {}),
    adSets,
    reasons,
    blocked: blockingReasons.length > 0,
    blockingReasons,
    testPlan: { creativeVariations, testDurationDays, decisionMetric },
  };
}
