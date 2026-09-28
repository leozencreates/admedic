import type { BriefLanguage } from "@admedic/llm";

export interface LeadFormTexts {
  /** Açık rıza bölümünün başlığı (Meta sınırı 60 karakter). */
  title: string;
  /** Açık rıza bölümünün gövdesi: yalnızca rızaya ilişkin bağlam; aydınlatma içeriği buraya yazılmaz. */
  body: string;
  /** Açık rıza beyanı (onay kutusu metni, Meta sınırı 200 karakter). */
  checkbox: string;
  /** Aydınlatma metnine giden bağlantının metni (Meta `privacy_policy.link_text`, en fazla 70 karakter). */
  privacyLink: string;
}

/**
 * Instant Form metinleri (spec 3.11; KVKK İlke Kararı 2026/347, ADR-0016). Aydınlatma ile açık rıza ayrı
 * başlık ve ayrı beyanlarla sunulur:
 * - Aydınlatma: kuruluşun aydınlatma metni sayfasına giden bağlantı (Meta'nın zorunlu gizlilik bağlantısı);
 *   aydınlatma için onay istenmez.
 * - Açık rıza: "Açık rıza" başlıklı özel bölüm ve rıza beyanı (onay kutusu).
 * Kuruluşa özel açık rıza metni (`Organization.consentText`) tek dilli bir alandır; yalnızca Türkçe
 * formlarda bölüm gövdesi olarak kullanılır. Metinler hukuki gözden geçirme bekler (ADR-0016 §Açık konular).
 */
const TEXTS: Record<BriefLanguage, LeadFormTexts> = {
  TR: {
    title: "Açık rıza",
    body: "Bu bölümde yalnızca açık rızanız istenir. Rızanızı dilediğiniz zaman geri çekebilirsiniz. Kişisel verilerinizin işlenmesine ilişkin bilgiler ayrıca \u201cAydınlatma metni\u201d bağlantısındadır.",
    checkbox: "Talebime yanıt verilmesi ve benimle iletişime geçilmesi amacıyla kişisel verilerimin işlenmesine açık rıza veriyorum.",
    privacyLink: "Aydınlatma metni",
  },
  EN: {
    title: "Explicit consent",
    body: "This section only asks for your explicit consent. You can withdraw it at any time. Information on how your personal data is processed is provided separately under \u201cPrivacy notice\u201d.",
    checkbox: "I give my explicit consent to the processing of my personal data to respond to my request and to contact me about it.",
    privacyLink: "Privacy notice",
  },
  DE: {
    title: "Ausdrückliche Einwilligung",
    body: "In diesem Abschnitt wird nur Ihre ausdrückliche Einwilligung eingeholt. Sie können sie jederzeit widerrufen. Informationen zur Verarbeitung Ihrer personenbezogenen Daten finden Sie gesondert unter \u201eDatenschutzhinweise\u201c.",
    checkbox: "Ich willige ausdrücklich ein, dass meine personenbezogenen Daten verarbeitet werden, um meine Anfrage zu beantworten und mich dazu zu kontaktieren.",
    privacyLink: "Datenschutzhinweise",
  },
  RU: {
    title: "Явное согласие",
    body: "В этом разделе запрашивается только ваше явное согласие. Вы можете отозвать его в любое время. Сведения об обработке ваших персональных данных приведены отдельно по ссылке \u00abУведомление о конфиденциальности\u00bb.",
    checkbox: "Я даю явное согласие на обработку моих персональных данных, чтобы ответить на мой запрос и связаться со мной по нему.",
    privacyLink: "Уведомление о конфиденциальности",
  },
  AR: {
    title: "موافقة صريحة",
    body: "يُطلب في هذا القسم موافقتك الصريحة فقط، ويمكنك سحبها في أي وقت. تجد المعلومات المتعلقة بمعالجة بياناتك الشخصية بشكل منفصل في رابط \u00abإشعار الخصوصية\u00bb.",
    checkbox: "أوافق صراحةً على معالجة بياناتي الشخصية للرد على طلبي والتواصل معي بشأنه.",
    privacyLink: "إشعار الخصوصية",
  },
  FR: {
    title: "Consentement explicite",
    body: "Cette section recueille uniquement votre consentement explicite. Vous pouvez le retirer à tout moment. Les informations sur le traitement de vos données personnelles figurent séparément dans l\u2019\u00ab\u00a0Avis de confidentialité\u00a0\u00bb.",
    checkbox: "Je consens explicitement au traitement de mes données personnelles afin de répondre à ma demande et de me contacter à ce sujet.",
    privacyLink: "Avis de confidentialité",
  },
  NL: {
    title: "Uitdrukkelijke toestemming",
    body: "In dit onderdeel wordt alleen om uw uitdrukkelijke toestemming gevraagd. U kunt deze op elk moment intrekken. Informatie over de verwerking van uw persoonsgegevens vindt u apart onder \u2018Privacyverklaring\u2019.",
    checkbox: "Ik geef uitdrukkelijk toestemming voor de verwerking van mijn persoonsgegevens om mijn aanvraag te beantwoorden en daarover contact met mij op te nemen.",
    privacyLink: "Privacyverklaring",
  },
  PL: {
    title: "Wyraźna zgoda",
    body: "W tej sekcji prosimy wyłącznie o Twoją wyraźną zgodę. Możesz ją wycofać w dowolnym momencie. Informacje o przetwarzaniu Twoich danych osobowych znajdziesz osobno w \u201eKlauzuli informacyjnej\u201d.",
    checkbox: "Wyrażam wyraźną zgodę na przetwarzanie moich danych osobowych w celu odpowiedzi na moje zapytanie i kontaktu ze mną w tej sprawie.",
    privacyLink: "Klauzula informacyjna",
  },
};

export function leadFormTexts(language: BriefLanguage, orgConsentText?: string | null): LeadFormTexts {
  const base = TEXTS[language];
  const custom = orgConsentText?.trim();
  return language === "TR" && custom ? { ...base, body: custom } : base;
}

/**
 * Formda gösterilen metnin kayıt için tek parça hali (LeadForm.consentText → ConsentRecord.consentText):
 * açık rıza başlığı, gövdesi, beyan (kutu metni) ve ayrıca sunulan aydınlatma metni bağlantısı —
 * kişinin gördüğü ve onayladığı metin budur (ispat yükü veri sorumlusunda, İlke Kararı 2026/347).
 */
export function leadFormConsentSnapshot(texts: LeadFormTexts, privacyPolicyUrl: string): string {
  return [texts.title, texts.body, `☑ ${texts.checkbox}`, `${texts.privacyLink}: ${privacyPolicyUrl}`].join("\n\n");
}
