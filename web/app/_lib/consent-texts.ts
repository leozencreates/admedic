/**
 * Panelden kaydedilen açık rıza (KVKK İlke Kararı 2026/347, ADR-0016). Saf modül: sunucu ve istemci kullanır.
 * Rızayı hasta verir; personel yalnızca verilen rızayı, nasıl ve ne zaman alındığıyla kaydeder.
 */

/** Kuruluş açık rıza metni tanımlamadıysa kayda geçen rıza beyanı (pazarlama iletişimi ve dönüşüm ölçümü). */
export const DEFAULT_MARKETING_CONSENT_TEXT =
  "Pazarlama iletişimi ve reklam ölçümü (Meta'ya dönüşüm bildirimi) amacıyla kişisel verilerimin işlenmesine açık rıza veriyorum.";

/** Telefonla aranma rızası (ADR-0026): sesli ajan yalnızca bu rıza kayıtlıyken arar. */
export const CALL_CONSENT_TEXT =
  "Bilgi talebimle ilgili olarak yapay zekâ destekli sesli asistan tarafından telefonla aranmayı ve görüşmenin kaydedilmesini kabul ediyorum.";

/** Rızanın nasıl alındığı (kanıt dayanağı); `ConsentRecord.evidence.basis`. */
export const CONSENT_EVIDENCE_BASES = [
  { value: "WRITTEN_MESSAGE", label: "Yazılı mesaj (WhatsApp, Messenger, Instagram)" },
  { value: "EMAIL", label: "E-posta" },
  { value: "SIGNED_FORM", label: "İmzalı form" },
  { value: "RECORDED_CALL", label: "Kayıtlı telefon görüşmesi" },
] as const;

export type ConsentEvidenceBasis = (typeof CONSENT_EVIDENCE_BASES)[number]["value"];

/** Bugünün tarihi (Europe/Istanbul) YYYY-MM-DD biçiminde; tarih alanının varsayılanı ve üst sınırı. */
export function todayInIstanbul(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(now);
}
