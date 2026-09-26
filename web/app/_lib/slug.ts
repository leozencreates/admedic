/**
 * Ad → URL dostu slug ("Özen Diş Kliniği" → "ozen-dis-klinigi"). Türkçe harfler
 * ASCII karşılıklarına indirgenir, diğer aksanlar NFKD ile ayrıştırılıp atılır.
 * İstemci ve sunucu tarafında ortak kullanılır (klinik/hizmet slug'ı).
 */
const TR_MAP: Record<string, string> = {
  ç: "c", Ç: "c", ğ: "g", Ğ: "g", ı: "i", I: "i", İ: "i", ö: "o", Ö: "o",
  ş: "s", Ş: "s", ü: "u", Ü: "u",
};

export function slugify(name: string, maxLength = 100): string {
  return name
    .replace(/[çÇğĞıIİöÖşŞüÜ]/g, (ch) => TR_MAP[ch] ?? ch)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}
