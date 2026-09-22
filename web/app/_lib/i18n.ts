export type Language = "tr" | "en" | "de" | "ru" | "ar";
export const SUPPORTED_LANGUAGES: Language[] = ["tr", "en", "de", "ru", "ar"];
export const DEFAULT_LANGUAGE: Language = "tr";

const dictionaries: Record<Language, Record<string, string>> = {
  tr: {
    "app.name": "Klinik Reklam Stüdyosu",
    "nav.leads": "Lead CRM",
    "nav.campaigns": "Kampanyalar",
    "nav.experiments": "Deneyler",
    "nav.settings": "Ayarlar",
    "lead.new": "Yeni Lead",
    "lead.status.new": "Yeni",
    "lead.status.contacted": "İletişime Geçildi",
    "lead.status.qualified": "Değerlendirildi",
    "lead.status.consultation_booked": "Danışma Randevusu",
    "lead.status.travel_planned": "Seyahat Planlandı",
    "lead.status.treated": "Tedavi Edildi",
    "lead.status.lost": "Kaybedildi",
    "lead.consent.grant": "Rıza Ver",
    "lead.consent.granted": "Onaylandı",
    "lead.consent.pending": "Beklemede",
    "consent.marketing": "Pazarlama iletişimleri için veri işleme onayı.",
    "button.submit": "Gönder",
    "button.cancel": "İptal",
    "button.save": "Kaydet",
    "error.generic": "Bir hata oluştu.",
    "success.saved": "Kaydedildi.",
  },
  en: {
    "app.name": "Clinic Ad Studio",
    "nav.leads": "Lead CRM",
    "nav.campaigns": "Campaigns",
    "nav.experiments": "Experiments",
    "nav.settings": "Settings",
    "lead.new": "New Lead",
    "lead.status.new": "New",
    "lead.status.contacted": "Contacted",
    "lead.status.qualified": "Qualified",
    "lead.status.consultation_booked": "Consultation Booked",
    "lead.status.travel_planned": "Travel Planned",
    "lead.status.treated": "Treated",
    "lead.status.lost": "Lost",
    "lead.consent.grant": "Grant Consent",
    "lead.consent.granted": "Granted",
    "lead.consent.pending": "Pending",
    "consent.marketing": "Consent for marketing communications.",
    "button.submit": "Submit",
    "button.cancel": "Cancel",
    "button.save": "Save",
    "error.generic": "An error occurred.",
    "success.saved": "Saved.",
  },
  de: {
    "app.name": "Klinik Werbe-Studio",
    "nav.leads": "Lead CRM",
    "nav.campaigns": "Kampagnen",
    "nav.experiments": "Experimente",
    "nav.settings": "Einstellungen",
    "lead.new": "Neuer Lead",
    "lead.status.new": "Neu",
    "lead.status.contacted": "Kontaktiert",
    "lead.status.qualified": "Qualifiziert",
    "lead.status.consultation_booked": "Beratung Vereinbart",
    "lead.status.travel_planned": "Reise Geplant",
    "lead.status.treated": "Behandelt",
    "lead.status.lost": "Verloren",
    "lead.consent.grant": "Einwilligung Gewähren",
    "lead.consent.granted": "Genehmigt",
    "lead.consent.pending": "Ausstehend",
    "consent.marketing": "Einwilligung für Marketingkommunikation.",
    "button.submit": "Senden",
    "button.cancel": "Abbrechen",
    "button.save": "Speichern",
    "error.generic": "Ein Fehler ist aufgetreten.",
    "success.saved": "Gespeichert.",
  },
  ru: {
    "app.name": "Клиническая Рекламная Студия",
    "nav.leads": "Лиды",
    "nav.campaigns": "Кампании",
    "nav.experiments": "Эксперименты",
    "nav.settings": "Настройки",
    "lead.new": "Новый лид",
    "lead.status.new": "Новый",
    "lead.status.contacted": "Контактирован",
    "lead.status.qualified": "Квалифицирован",
    "lead.status.consultation_booked": "Консультация Назначена",
    "lead.status.travel_planned": "Путешествие Запланировано",
    "lead.status.treated": "Лечен",
    "lead.status.lost": "Потерян",
    "lead.consent.grant": "Дать Согласие",
    "lead.consent.granted": "Дано",
    "lead.consent.pending": "Ожидает",
    "consent.marketing": "Согласие на маркетинговые коммуникации.",
    "button.submit": "Отправить",
    "button.cancel": "Отмена",
    "button.save": "Сохранить",
    "error.generic": "Произошла ошибка.",
    "success.saved": "Сохранено.",
  },
  ar: {
    "app.name": "استوديو الإعلانات الطبية",
    "nav.leads": "عملاء محتملون",
    "nav.campaigns": "الحملات",
    "nav.experiments": "التجارب",
    "nav.settings": "الإعدادات",
    "lead.new": "عميل محتمل جديد",
    "lead.status.new": "جديد",
    "lead.status.contacted": "تم التواصل",
    "lead.status.qualified": "مؤهل",
    "lead.status.consultation_booked": "استشارة مجدولة",
    "lead.status.travel_planned": "سفر مخطط",
    "lead.status.treated": "معالج",
    "lead.status.lost": "فقدان",
    "lead.consent.grant": "منح الموافقة",
    "lead.consent.granted": "موافق",
    "lead.consent.pending": "قيد الانتظار",
    "consent.marketing": "الموافقة على التواصل التسويقي.",
    "button.submit": "إرسال",
    "button.cancel": "إلغاء",
    "button.save": "حفظ",
    "error.generic": "حدث خطأ.",
    "success.saved": "تم الحفظ.",
  },
};

export function t(key: string, lang: Language = DEFAULT_LANGUAGE): string {
  return dictionaries[lang]?.[key] ?? dictionaries[DEFAULT_LANGUAGE]?.[key] ?? key;
}

export function getLanguage(): Language {
  if (typeof window === "undefined") return DEFAULT_LANGUAGE;
  const stored = localStorage.getItem("admedic_lang") as Language | null;
  if (stored && SUPPORTED_LANGUAGES.includes(stored)) return stored;
  const nav = navigator.language.split("-")[0] as Language;
  if (SUPPORTED_LANGUAGES.includes(nav)) return nav;
  return DEFAULT_LANGUAGE;
}

export function setLanguage(lang: Language): void {
  if (typeof window !== "undefined") {
    localStorage.setItem("admedic_lang", lang);
  }
}

export function formatLeadStatus(status: string, lang: Language = DEFAULT_LANGUAGE): string {
  const labelKey = `lead.status.${status.toLowerCase()}`;
  return t(labelKey, lang);
}
