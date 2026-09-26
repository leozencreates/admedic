import { z } from "zod";

/**
 * Meta `call_to_action.type` değerleri (link data CTA; bkz. docs/meta-constraints.md,
 * 2026-09-26 notu). Kreatif çıktısındaki CTA bu kümeden biridir; LLM serbest metin
 * döndürürse `normalizeCta` en yakın değere eşler.
 */
export const META_CTA_TYPES = [
  "LEARN_MORE",
  "SIGN_UP",
  "CONTACT_US",
  "WHATSAPP_MESSAGE",
  "BOOK_NOW",
  "GET_QUOTE",
  "APPLY_NOW",
  "MESSAGE_PAGE",
  "SEND_MESSAGE",
] as const;
export const MetaCtaEnum = z.enum(META_CTA_TYPES);
export type MetaCta = z.infer<typeof MetaCtaEnum>;
export const DEFAULT_CTA: MetaCta = "LEARN_MORE";

/** Panelde gösterilen Türkçe etiketler. */
export const CTA_LABELS: Record<MetaCta, string> = {
  LEARN_MORE: "Daha fazla bilgi",
  SIGN_UP: "Kaydol",
  CONTACT_US: "Bize ulaşın",
  WHATSAPP_MESSAGE: "WhatsApp'tan yazın",
  BOOK_NOW: "Randevu al",
  GET_QUOTE: "Teklif al",
  APPLY_NOW: "Hemen başvur",
  MESSAGE_PAGE: "Sayfaya mesaj gönder (Messenger)",
  SEND_MESSAGE: "Mesaj gönder",
};

/**
 * Serbest metin → CTA eşlemesi; sıra önemlidir (WhatsApp, randevu ve teklif gibi
 * özgül ifadeler genel "mesaj/iletişim/bilgi" kalıplarından önce denenir).
 */
const CTA_PATTERNS: Array<[MetaCta, RegExp]> = [
  ["WHATSAPP_MESSAGE", /whatsapp|whats app|واتساب|واتس|ватсап|вотсап|wa\b/iu],
  [
    "BOOK_NOW",
    /\bbook|appointment|consultation|randevu|konsültasyon|termin|buchen|записа|запись|консультац|احجز|حجز|موعد|استشار|réserv|rendez|consultation|afspraak|boek|umów|rezerw|wizyt|konsultac/iu,
  ],
  [
    "GET_QUOTE",
    /quote|estimate|teklif|fiyat teklifi|angebot|kostenvoranschlag|предложени|смет|расчет|расчёт|عرض سعر|عرض|تسعير|devis|offerte|prijsopgave|wycen|oferta/iu,
  ],
  [
    "SIGN_UP",
    /sign ?up|register|kaydol|kayıt ol|üye ol|registrier|anmeld|регистр|записывайтесь|سجل|سجّل|اشترك|inscri|inschrijv|aanmeld|zarejestr|zapisz się/iu,
  ],
  [
    "APPLY_NOW",
    /\bapply|başvur|bewerb|beantrag|подать заявку|заявк|قدم|قدّم|تقدم|postul|candidat|solliciteer|aanvragen|aplikuj|złóż wniosek/iu,
  ],
  [
    "MESSAGE_PAGE",
    /\bmessage|\bdm\b|mesaj|nachricht|schreiben sie|сообщени|напишите|رسالة|راسل|envoyer un message|écrivez|bericht|stuur|wiadomość|napisz/iu,
  ],
  [
    "CONTACT_US",
    /contact|iletişim|ulaş|arayın|\bcall\b|kontakt|anrufen|связ|свяж|позвон|اتصل|تواصل|contactez|appelez|contacteer|neem contact|bel ons|skontaktuj|zadzwoń/iu,
  ],
  [
    "LEARN_MORE",
    /learn|\bmore\b|\binfo|bilgi|detay|keşfet|mehr|erfahren|подробнее|узнать|больше|المزيد|اعرف|اكتشف|savoir|découvr|meer|ontdek|dowiedz|więcej|poznaj/iu,
  ],
];

/** Serbest CTA metnini Meta CTA türüne indirger; eşleşme yoksa `LEARN_MORE`. */
export function normalizeCta(input: string | null | undefined): MetaCta {
  const raw = (input ?? "").trim();
  if (!raw) return DEFAULT_CTA;
  const asId = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if ((META_CTA_TYPES as readonly string[]).includes(asId)) return asId as MetaCta;
  const text = raw.normalize("NFKC").toLocaleLowerCase("tr");
  for (const [cta, pattern] of CTA_PATTERNS) {
    if (pattern.test(text)) return cta;
  }
  return DEFAULT_CTA;
}
