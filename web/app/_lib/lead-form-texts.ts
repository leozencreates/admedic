import type { BriefLanguage } from "@admedic/llm";

export interface LeadFormTexts {
  /** Rıza bölümü başlığı (Meta sınırı 60 karakter). */
  title: string;
  body: string;
  checkbox: string;
  privacyLink: string;
}

/**
 * Instant Form rıza metinleri (spec 3.11): form, reklamın dilinde gösterilir. Kuruluşa özel rıza
 * metni (`Organization.consentText`) tek dilli bir alandır; yalnızca Türkçe formlarda gövde olarak
 * kullanılır, diğer dillerde aşağıdaki genel metin ve kuruluşun gizlilik politikası bağlantısı gösterilir.
 * Dil başına kuruluş metni ileride ayar olarak eklenebilir (docs/remaining-work.md).
 */
const TEXTS: Record<BriefLanguage, LeadFormTexts> = {
  TR: {
    title: "Kişisel verilerin işlenmesi",
    body: "Paylaştığınız bilgiler, talebinize yanıt vermek ve bu konuda sizinle iletişime geçmek amacıyla işlenir. Ayrıntılar gizlilik politikamızda yer alır.",
    checkbox: "Kişisel verilerimin bu amaçla işlenmesine ve benimle iletişime geçilmesine onay veriyorum.",
    privacyLink: "Gizlilik politikası",
  },
  EN: {
    title: "Consent to data processing",
    body: "The information you share is processed to respond to your request and to contact you about it. See our privacy policy for details.",
    checkbox: "I agree to the processing of my personal data for this purpose and to being contacted.",
    privacyLink: "Privacy policy",
  },
  DE: {
    title: "Einwilligung zur Datenverarbeitung",
    body: "Ihre Angaben werden verarbeitet, um Ihre Anfrage zu beantworten und Sie dazu zu kontaktieren. Einzelheiten finden Sie in unserer Datenschutzerklärung.",
    checkbox: "Ich willige in die Verarbeitung meiner personenbezogenen Daten zu diesem Zweck und in die Kontaktaufnahme ein.",
    privacyLink: "Datenschutzerklärung",
  },
  RU: {
    title: "Согласие на обработку данных",
    body: "Предоставленные вами данные обрабатываются, чтобы ответить на ваш запрос и связаться с вами по нему. Подробнее — в нашей политике конфиденциальности.",
    checkbox: "Я даю согласие на обработку моих персональных данных с этой целью и на связь со мной.",
    privacyLink: "Политика конфиденциальности",
  },
  AR: {
    title: "الموافقة على معالجة البيانات",
    body: "تتم معالجة المعلومات التي تشاركها للرد على طلبك والتواصل معك بشأنه. للاطلاع على التفاصيل راجع سياسة الخصوصية.",
    checkbox: "أوافق على معالجة بياناتي الشخصية لهذا الغرض وعلى التواصل معي.",
    privacyLink: "سياسة الخصوصية",
  },
  FR: {
    title: "Consentement au traitement des données",
    body: "Les informations que vous partagez sont traitées pour répondre à votre demande et vous contacter à ce sujet. Consultez notre politique de confidentialité pour plus de détails.",
    checkbox: "J'accepte le traitement de mes données personnelles à cette fin et d'être contacté(e).",
    privacyLink: "Politique de confidentialité",
  },
  NL: {
    title: "Toestemming voor gegevensverwerking",
    body: "De gegevens die u deelt, worden verwerkt om uw aanvraag te beantwoorden en daarover contact met u op te nemen. Zie ons privacybeleid voor details.",
    checkbox: "Ik ga akkoord met de verwerking van mijn persoonsgegevens voor dit doel en met contact over mijn aanvraag.",
    privacyLink: "Privacybeleid",
  },
  PL: {
    title: "Zgoda na przetwarzanie danych",
    body: "Udostępnione przez Ciebie informacje są przetwarzane w celu odpowiedzi na Twoje zapytanie i kontaktu w tej sprawie. Szczegóły znajdziesz w naszej polityce prywatności.",
    checkbox: "Wyrażam zgodę na przetwarzanie moich danych osobowych w tym celu oraz na kontakt ze mną.",
    privacyLink: "Polityka prywatności",
  },
};

export function leadFormTexts(language: BriefLanguage, orgConsentText?: string | null): LeadFormTexts {
  const base = TEXTS[language];
  const custom = orgConsentText?.trim();
  return language === "TR" && custom ? { ...base, body: custom } : base;
}

/**
 * Formda gösterilen rıza metninin kayıt için tek parça hali (LeadForm.consentText → ConsentRecord.consentText):
 * başlık, gövde, kutu metni ve gizlilik politikası bağlantısı — kişinin onayladığı metin budur.
 */
export function leadFormConsentSnapshot(texts: LeadFormTexts, privacyPolicyUrl: string): string {
  return [texts.title, texts.body, `☑ ${texts.checkbox}`, `${texts.privacyLink}: ${privacyPolicyUrl}`].join("\n\n");
}
