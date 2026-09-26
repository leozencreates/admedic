import { it, expect } from "vitest";
import { CTA_LABELS, META_CTA_TYPES, MetaCtaEnum, normalizeCta } from "./cta";

it("keeps exact Meta CTA identifiers (any casing/punctuation)", () => {
  for (const cta of META_CTA_TYPES) {
    expect(normalizeCta(cta)).toBe(cta);
    expect(normalizeCta(cta.toLowerCase())).toBe(cta);
    expect(normalizeCta(cta.replace("_", " "))).toBe(cta);
  }
  expect(Object.keys(CTA_LABELS).sort()).toEqual([...META_CTA_TYPES].sort());
  expect(MetaCtaEnum.safeParse("Learn more").success).toBe(false);
});

it("maps free-text CTAs in all creative languages to the nearest Meta type", () => {
  const cases: Array<[string, string]> = [
    ["Learn more", "LEARN_MORE"],
    ["Bilgi alın", "LEARN_MORE"],
    ["Mehr erfahren", "LEARN_MORE"],
    ["Подробнее", "LEARN_MORE"],
    ["اعرف المزيد", "LEARN_MORE"],
    ["En savoir plus", "LEARN_MORE"],
    ["Meer informatie", "LEARN_MORE"],
    ["Dowiedz się więcej", "LEARN_MORE"],
    ["WhatsApp'tan Yazın", "WHATSAPP_MESSAGE"],
    ["Написать в WhatsApp", "WHATSAPP_MESSAGE"],
    ["Jetzt Termin buchen", "BOOK_NOW"],
    ["Записаться на консультацию", "BOOK_NOW"],
    ["Randevu al", "BOOK_NOW"],
    ["Prendre rendez-vous", "BOOK_NOW"],
    ["Umów wizytę", "BOOK_NOW"],
    ["احصل على عرض سعر", "GET_QUOTE"],
    ["Get a quote", "GET_QUOTE"],
    ["Teklif alın", "GET_QUOTE"],
    ["Contactez-nous", "CONTACT_US"],
    ["Bize ulaşın", "CONTACT_US"],
    ["Neem contact op", "CONTACT_US"],
    ["Aanmelden", "SIGN_UP"],
    ["Sign up today", "SIGN_UP"],
    ["Kaydol", "SIGN_UP"],
    ["Aplikuj teraz", "APPLY_NOW"],
    ["Hemen başvur", "APPLY_NOW"],
    ["Send message", "SEND_MESSAGE"],
    ["Send us a message", "MESSAGE_PAGE"],
    ["Mesaj gönder", "MESSAGE_PAGE"],
    ["Napisz do nas", "MESSAGE_PAGE"],
  ];
  for (const [input, expected] of cases) expect(normalizeCta(input), input).toBe(expected);
});

it("falls back to LEARN_MORE for empty or unrecognised text", () => {
  expect(normalizeCta("")).toBe("LEARN_MORE");
  expect(normalizeCta(null)).toBe("LEARN_MORE");
  expect(normalizeCta("   ")).toBe("LEARN_MORE");
  expect(normalizeCta("Lorem ipsum")).toBe("LEARN_MORE");
});
