import { formatMoney } from "./format";
import { budgetModeLabel, languageName } from "./labels";

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
  /** Kuruluşun hâlihazırda aktif kampanyalarının aylık toplamı (minor unit); sınır bu toplam + plan ile karşılaştırılır. */
  monthlyCommittedCents?: number;
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
  /** Diğer aktif kampanyaların aylık toplamı (minor unit; sınır kontrolünde plana eklenir). */
  monthlyCommittedCents: number;
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

/**
 * Planlayıcı hedefi → kampanya hedefi adı (Meta'nın Türkçe arayüzündeki adlar; Meta'dan gelen
 * OUTCOME_* değerleri için `labels.ts` `objectiveLabel` aynı adları verir). Plan adında da kullanılır.
 */
export const OBJECTIVE_LABEL: Record<PlanObjective, string> = {
  MAX_ROAS: "Satış",
  MAX_CONVERSIONS: "Potansiyel müşteri",
  MAX_IMPRESSIONS: "Bilinirlik",
};

const OBJECTIVE_REASON: Record<PlanObjective, string> = {
  MAX_ROAS:
    "Satış odaklı hedef: Meta, dönüşüm değeri en yüksek kitleye optimize eder; yüksek paket değerli tedavilerde reklam getirisi (ROAS) ölçülebildiği için seçildi.",
  MAX_CONVERSIONS:
    "Lead odaklı hedef: Meta, reklamı form veya WhatsApp başvurusu yapma olasılığı en yüksek kişilere gösterir; sağlık turizminde ana dönüşüm konsültasyon talebidir.",
  MAX_IMPRESSIONS:
    "Bilinirlik odaklı hedef: Meta, pazara yeni giren klinik için erişim ve sıklıkla ilk teması kurar; bu aşamada lead beklentisi düşük tutulur.",
};

export const METHOD_LABEL: Record<ConversionMethod, string> = {
  landing_form: "Açılış sayfası formu",
  instant_form: "Anında Form",
  whatsapp: "WhatsApp",
  instagram_dm: "Instagram DM",
};

const METHOD_REASON: Record<ConversionMethod, string> = {
  landing_form:
    "Açılış sayfası formu: aydınlatma ve açık rıza metinleri ile ön eleme soruları sizin kontrolünüzde; Anında Form'a göre hacim daha düşük, lead'ler daha nitelikli.",
  instant_form:
    "Anında Form (Meta lead reklamı): Facebook veya Instagram içinde doldurulduğu için sürtünme en düşük, lead hacmi en yüksektir; açık rıza metni ve ön eleme soruları forma eklenir.",
  whatsapp:
    "WhatsApp'a yönlendiren reklam: Körfez ve Rusça konuşulan pazarlarda tercih edilen kanal; ilk yanıtı karşılama asistanı verir, 24 saatlik mesajlaşma penceresi kuralına uyulur.",
  instagram_dm:
    "Instagram DM: görsel ağırlıklı hizmetlerde (estetik, diş) genç kitlede etkileşim yüksektir; koordinatöre devir için mesaj otomasyonu gerekir.",
};

/** Dil kodları → Türkçe dil adları ("DE/TR" → "Almanca/Türkçe"); gerekçe ve yapı metinleri için. */
function languageNames(codes: readonly string[], separator = "/"): string {
  return codes.map((code) => languageName(code)).join(separator);
}

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

/**
 * Plan ve aylık üst sınır mesajlarındaki tutarlar (`format.ts`, "€1.234"). Kuruş varsa 2 ondalık
 * gösterilir; sınır karşılaştırmasında yuvarlama "€6.000 > €6.000" gibi yanıltıcı metin üretmesin.
 */
export function formatPlanMoney(cents: number, currency: string): string {
  return formatMoney(cents, currency, { precise: !Number.isInteger(cents / 100) });
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
  const monthlyCommittedCents = Math.max(0, Math.round(input.monthlyCommittedCents ?? 0));
  if (input.monthlyCapCents != null && monthlyCommittedCents + monthlyProjectedCents > input.monthlyCapCents)
    blockingReasons.push(
      monthlyCommittedCents > 0
        ? `Etkin kampanyaların aylık toplamı (${formatPlanMoney(monthlyCommittedCents, currency)}) ile bu planın aylık tahmini (${formatPlanMoney(monthlyProjectedCents, currency)}) aylık harcama üst sınırını (${formatPlanMoney(input.monthlyCapCents, currency)}) aşıyor. Günlük bütçeyi düşürün ya da üst sınırı yükseltin.`
        : `Bu planın aylık tahmini (${formatPlanMoney(monthlyProjectedCents, currency)}) aylık harcama üst sınırını (${formatPlanMoney(input.monthlyCapCents, currency)}) aşıyor. Günlük bütçeyi düşürün ya da üst sınırı yükseltin.`,
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
      ? `${marketCount} pazar ve ${campaignLangs.length} dil tek kampanyada, kampanya bütçesiyle (CBO) birleştirilir; Meta günlük bütçeyi lead başı maliyeti en düşük reklam setine otomatik dağıtır ve küçük pazarlar bütçesiz kalmaz.`
      : `${marketCount} pazar ve ${campaignLangs.length} dil için reklam seti bütçesi (ABO): her pazar sabit pay alır; hedefleme hassasiyeti ve pazar başına harcama kontrolü korunur.`;

  const marketText = adSetMarkets
    .map((m) => `${PLANNER_MARKETS[m] ?? m} (${languageNames(marketLanguagesFor(m, overrides))})`)
    .join(", ");
  const targetingReason =
    `${ageMin}-${ageMax} yaş; pazarlar: ${marketText}${markets.length > MAX_PLAN_AD_SETS ? ` (+${markets.length - MAX_PLAN_AD_SETS} pazar ikinci kampanyaya bırakıldı)` : ""}. ` +
    `Diller ${usedClinicTargets ? "klinik pazar hedeflerinden" : "pazar-dil eşleşmesinden"} türetildi${explicitLangs.length > 0 ? ", seçtiğiniz dillerle kesiştirildi" : ""}; ` +
    "18 yaş altı hariç tutulur (Meta sağlık reklamı kuralı) ve kişisel özellik varsayımı içeren hedefleme kullanılmaz.";

  const whatsappHint =
    input.conversionMethod !== "whatsapp" && adSetMarkets.some((m) => WHATSAPP_FIRST_MARKETS.has(m))
      ? " Seçilen pazarlarda WhatsApp birincil kanal olduğundan WhatsApp'a yönlendiren bir reklam varyantını da değerlendirin."
      : "";
  const conversionReason = METHOD_REASON[input.conversionMethod] + whatsappHint;

  const testDurationDays = marketCount > 1 ? 7 : 14;
  const creativeVariations = 3; // 1 kontrol + 2 varyant
  const decisionMetric = "Lead başı maliyet (CPL)";
  const testPlanReason =
    `Her reklam setinde 1 kontrol + 2 varyant (${creativeVariations} varyasyon) ${testDurationDays} gün yayınlanır. ` +
    `Karar ölçütü: ${decisionMetric}. ${strategy === "CBO" ? "Kampanya bütçesinde (CBO) Meta bütçeyi eşit dağıtmasa da" : "Reklam seti bütçesinde (ABO) paylar eşit olduğundan"} lead başı maliyet ve lead sayısı kıyaslanır; kazanan varyant ölçeklenir.`;

  const structure =
    `${budgetModeLabel(strategy)} — ${adSets.length} reklam seti (pazar başına: ${adSetMarkets.map((m) => PLANNER_MARKETS[m] ?? m).join(", ") || "—"}), ` +
    `her reklam setinde 1 kontrol + 2 varyant, diller ${languageNames(campaignLangs, ", ")}, dönüşüm yöntemi ${METHOD_LABEL[input.conversionMethod]}`;

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
    monthlyCommittedCents,
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
