export type PlanObjective = "MAX_ROAS" | "MAX_CONVERSIONS" | "MAX_IMPRESSIONS";
export type ConversionMethod = "landing_form" | "whatsapp" | "instagram_dm";

export interface CampaignPlanInput {
  objective: PlanObjective;
  dailyBudgetCents: number;
  monthlyCapCents?: number;
  markets: string[];
  ageMin?: number;
  ageMax?: number;
  languages: string[];
  conversionMethod: ConversionMethod;
}

export interface CampaignPlan {
  name: string;
  dailyBudgetCents: number;
  monthlyProjectedCents: number;
  structure: string;
  strategy: "CBO" | "ABO";
  rationale: string;
  targetingRatione: string;
  blocked: boolean;
  blockingReasons: string[];
}

const OBJECTIVE_LABEL: Record<PlanObjective, string> = {
  MAX_ROAS: "Maks. ROAS",
  MAX_CONVERSIONS: "Maks. Dönüşüm",
  MAX_IMPRESSIONS: "Maks. Görüntüleme",
};

const METHOD_LABEL: Record<ConversionMethod, string> = {
  landing_form: "Açılış Sayfası",
  whatsapp: "WhatsApp",
  instagram_dm: "Instagram DM",
};

export const COUNTRY_LANGUAGE_MAP: Record<string, string[]> = {
  DE: ["DE"],
  TR: ["TR"],
  RU: ["RU"],
  GB: ["EN"],
  GULF: ["AR", "EN"],
  USA: ["EN"],
  NETHERLANDS: ["NL", "EN"],
};

export function marketLanguages(markets: string[]): string[] {
  const langs = new Set<string>();
  for (const m of markets) {
    const mapped = COUNTRY_LANGUAGE_MAP[m] ?? ["EN"];
    for (const l of mapped) langs.add(l);
  }
  return langs.size > 0 ? Array.from(langs) : ["EN"];
}

export function buildCampaignPlan(input: CampaignPlanInput): CampaignPlan {
  const blockingReasons: string[] = [];
  const ageMin = input.ageMin ?? 18;
  const ageMax = input.ageMax ?? 54;
  if (ageMin < 18 || ageMax < 18)
    blockingReasons.push("Hedefleme 18 yaş altı kullanıcıları içeremez.");
  if (!input.markets.length)
    blockingReasons.push("En az bir pazar (ülke) seçilmelidir.");
  if (!Number.isFinite(input.dailyBudgetCents) || input.dailyBudgetCents <= 0)
    blockingReasons.push("Günlük bütçe pozitif bir değer olmalıdır.");
  const monthlyProjectedCents = input.dailyBudgetCents * 30;
  if (
    input.monthlyCapCents != null &&
    monthlyProjectedCents > input.monthlyCapCents
  )
    blockingReasons.push(
      `Aylık öngörülen bütçe (${monthlyProjectedCents / 100} TL) kuruluş üst sınırını (${input.monthlyCapCents / 100} TL) aşıyor.`,
    );

  const mainMarket = input.markets[0] ?? "belirsiz";
  const marketCount = input.markets.length;
  const autoLangs = input.languages.length === 0 ? marketLanguages(input.markets) : input.languages;
  const lang = autoLangs[0] ?? "İngilizce";
  const label = OBJECTIVE_LABEL[input.objective];
  const name = `${label} — ${mainMarket}`;

  const strategy: "CBO" | "ABO" = marketCount > 1 || autoLangs.length > 1 ? "CBO" : "ABO";
  const rationale =
    strategy === "CBO"
      ? `${marketCount} pazar tek bir bütçe kampanyasında birleştirilir; Meta, bütçeyi en iyi performans gösteren reklam setine otomatik dağıtır.`
      : `${marketCount} pazar / ${autoLangs.length} dil için tek bağımsız ad set ile hedefleme hassasiyeti korunur; bütçe elle dağıtılır.`;
  const structure = `${strategy} — 1 kontrol + 2 varyant ad set, reklam dili ${lang}, dönüşüm ${METHOD_LABEL[input.conversionMethod]}`;

  return {
    name,
    dailyBudgetCents: input.dailyBudgetCents,
    monthlyProjectedCents: monthlyProjectedCents,
    structure,
    strategy,
    rationale,
    targetingRatione: `${ageMin}-${ageMax} yaş, pazarlar: ${input.markets.join(", ")}`,
    blocked: blockingReasons.length > 0,
    blockingReasons,
  };
}