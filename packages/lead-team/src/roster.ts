/**
 * Lead takımı kadrosu (ADR-0029): 1 direktör, 7 takım lideri, 42 uzman = 50 ajan.
 * Uzman kendi liderine, lider direktöre rapor verir; nihai kararı direktör verir.
 * `title` panelde gösterilir (Türkçe); `focus` ve `mission` isteme girer (İngilizce).
 */

export type AgentRole = "DIRECTOR" | "LEAD" | "SPECIALIST";

export interface AgentDef {
  /** Kalıcı anahtar: "director", "lead:<takım>", "<takım>:<uzman>". */
  key: string;
  role: AgentRole;
  /** Direktörde null. */
  team: string | null;
  title: string;
  /** Uzmanda odak, liderde takım görevi; direktörde boş. */
  focus: string;
}

export interface TeamDef {
  key: string;
  title: string;
  mission: string;
  specialists: ReadonlyArray<{ key: string; title: string; focus: string }>;
}

export const TEAMS: readonly TeamDef[] = [
  {
    key: "market",
    title: "Pazar",
    mission: "Decide which target markets deserve ad budget now, based on the clinic's market targets, languages and past results.",
    specialists: [
      { key: "turkey", title: "Türkiye pazarı", focus: "Demand for the clinic's services from patients in Turkey; domestic competition and price sensitivity." },
      { key: "germany", title: "Almanya pazarı", focus: "Patients in Germany, including the Turkish diaspora; trust signals German-speaking patients expect." },
      { key: "uk", title: "Birleşik Krallık pazarı", focus: "Patients in the United Kingdom; waiting-time driven demand and travel logistics." },
      { key: "netherlands", title: "Hollanda pazarı", focus: "Patients in the Netherlands and Belgium; Dutch-language demand and diaspora." },
      { key: "usa", title: "ABD pazarı", focus: "Patients in the United States; cost-driven demand, long travel and high expectations for credentials." },
      { key: "gulf", title: "Körfez pazarı", focus: "Patients in Gulf countries; Arabic-language demand, family travel and privacy expectations." },
      { key: "other", title: "Diğer pazarlar", focus: "Markets outside the main list that the clinic's languages could serve (e.g. France, Poland, the Balkans)." },
    ],
  },
  {
    key: "language",
    title: "Dil ve mesaj",
    mission: "Decide which ad languages to run and how the message should sound in each, using only languages the clinic can serve.",
    specialists: [
      { key: "tr", title: "Türkçe mesaj", focus: "Turkish ad copy tone and the wording that earns trust without promises." },
      { key: "en", title: "İngilizce mesaj", focus: "English ad copy for international patients; plain, credible wording." },
      { key: "de", title: "Almanca mesaj", focus: "German ad copy; formal address and factual tone." },
      { key: "ru", title: "Rusça mesaj", focus: "Russian ad copy; polite formal tone and clarity about the process." },
      { key: "ar", title: "Arapça mesaj", focus: "Arabic ad copy; respectful tone and right-to-left layout considerations." },
      { key: "fr", title: "Fransızca mesaj", focus: "French ad copy; formal address and reassurance about follow-up care." },
      { key: "nl", title: "Felemenkçe mesaj", focus: "Dutch ad copy; direct, modest tone." },
      { key: "pl", title: "Lehçe mesaj", focus: "Polish ad copy; formal address and transparent process description." },
    ],
  },
  {
    key: "service",
    title: "Hizmet",
    mission: "Decide which of the clinic's services to advertise first, using the service catalogue and past lead interest.",
    specialists: [
      { key: "medical", title: "Tıbbi hizmetler", focus: "General medical services in the clinic catalogue and how to present them without medical claims." },
      { key: "dental", title: "Diş hizmetleri", focus: "Dental services in the catalogue; typical trip length and what patients ask first." },
      { key: "wellness", title: "Sağlıklı yaşam", focus: "Wellness services in the catalogue; framing that avoids health-condition implications." },
      { key: "surgical", title: "Cerrahi hizmetler", focus: "Surgical services in the catalogue; safety, credentials and recovery information patients need." },
      { key: "diagnostic", title: "Teşhis hizmetleri", focus: "Diagnostic and check-up services in the catalogue; short-stay packages." },
      { key: "psychiatric", title: "Psikiyatri hizmetleri", focus: "Psychiatric services in the catalogue; extra care for privacy and Meta's personal-attribute rules." },
      { key: "packages", title: "Paket ve konaklama", focus: "Package contents across services (hotel, transfer, interpreter) and how they support lead generation." },
    ],
  },
  {
    key: "audience",
    title: "Kitle ve hedefleme",
    mission: "Propose audience and placement set-ups that are allowed for health advertising and likely to produce qualified leads.",
    specialists: [
      { key: "demographics", title: "Yaş ve demografi", focus: "Age ranges and locations to target, never health conditions or other personal attributes." },
      { key: "interests", title: "İlgi alanları", focus: "Interest-based and broad targeting options that stay within Meta's health advertising rules." },
      { key: "retargeting", title: "Yeniden hedefleme", focus: "Retargeting website visitors and engaged users, and lookalike audiences built from consented leads only." },
      { key: "placements", title: "Yerleşimler", focus: "Placements (feed, stories, reels) and formats that suit lead forms and click-to-message ads." },
      { key: "timing", title: "Dönem ve zamanlama", focus: "Seasonality, days and hours that matter for each market, and how quickly the team can answer new leads." },
    ],
  },
  {
    key: "creative",
    title: "Kreatif açı",
    mission: "Propose message angles that are compliant, distinct from each other and worth testing against each other.",
    specialists: [
      { key: "trust", title: "Güven ve akreditasyon", focus: "Angles built on accreditations, licence and transparent process, using only facts in the clinic context." },
      { key: "journey", title: "Hasta yolculuğu", focus: "Angles that explain the journey step by step: first contact, consultation, travel, aftercare." },
      { key: "team", title: "Hekim ve ekip", focus: "Angles that present the medical team and coordinators without outcome promises." },
      { key: "comfort", title: "Konfor ve konaklama", focus: "Angles about accommodation, transfers and language support." },
      { key: "questions", title: "Soru ve çekinceler", focus: "Angles that answer common questions and hesitations honestly, without prices or guarantees." },
    ],
  },
  {
    key: "budget",
    title: "Bütçe ve test",
    mission: "Propose how much to spend per day, how to split it and how to test, within the monthly cap and current commitments.",
    specialists: [
      { key: "allocation", title: "Bütçe dağıtımı", focus: "Splitting the daily budget across markets and languages given the monthly cap and active campaigns." },
      { key: "cpl", title: "Lead başı maliyet", focus: "Cost per lead in past results; where it is too high or data is too thin to judge." },
      { key: "testing", title: "Test planı", focus: "Which two or three variants to test first and how long before deciding." },
      { key: "scaling", title: "Ölçekleme", focus: "When and how to raise budgets safely after a test, and when to stop." },
      { key: "pacing", title: "Harcama temposu", focus: "Daily pacing risks: launching too many campaigns at once, learning-phase resets, weekend effects." },
    ],
  },
  {
    key: "compliance",
    title: "Uyum ve lead kalitesi",
    mission: "Protect the plan: flag policy and privacy risks and make sure new leads can be handled well once they arrive.",
    specialists: [
      { key: "policy", title: "Reklam politikası", focus: "Meta health advertising policy risks in the likely proposals and the clinic's banned phrases." },
      { key: "consent", title: "Rıza ve KVKK", focus: "Consent and privacy notice requirements for lead forms and follow-up messaging." },
      { key: "form", title: "Lead formu", focus: "Lead form questions that qualify without asking for health details that are not needed." },
      { key: "response", title: "Yanıt hızı", focus: "Whether the team can answer new leads quickly in each proposed language, based on the lead funnel data." },
      { key: "losses", title: "Kayıp nedenleri", focus: "Why past leads were lost and what that implies for targeting and messaging." },
    ],
  },
];

export const DIRECTOR: AgentDef = { key: "director", role: "DIRECTOR", team: null, title: "Direktör", focus: "" };

export function leadOf(team: TeamDef): AgentDef {
  return { key: `lead:${team.key}`, role: "LEAD", team: team.key, title: `${team.title} takım lideri`, focus: team.mission };
}

export function specialistsOf(team: TeamDef): AgentDef[] {
  return team.specialists.map((s) => ({ key: `${team.key}:${s.key}`, role: "SPECIALIST", team: team.key, title: s.title, focus: s.focus }));
}

/** Tüm kadro: direktör, liderler, uzmanlar. */
export const ROSTER: readonly AgentDef[] = [DIRECTOR, ...TEAMS.map(leadOf), ...TEAMS.flatMap(specialistsOf)];

export const TEAM_SIZE = ROSTER.length;
