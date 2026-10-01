/**
 * Aramanın açılış cümlesi (ADR-0026): karşı tarafa yapay zekâ ile konuştuğu ve görüşmenin kaydedildiği her
 * aramanın başında söylenir (ElevenLabs Agents şartları; docs/elevenlabs-constraints.md). Metin ajan ayarına
 * bırakılmaz, her aramada buradan gönderilir.
 */

const FIRST_MESSAGE: Record<string, string> = {
  tr: "Merhaba {name}, {clinic} adına arıyorum. Ben yapay zekâ destekli bir sesli asistanım ve bu görüşme kaydedilmektedir. Bilgi talebinizle ilgili birkaç dakikanız var mı?",
  en: "Hello {name}, I'm calling on behalf of {clinic}. I'm an AI voice assistant, and this call is being recorded. Do you have a few minutes to talk about your enquiry?",
  de: "Guten Tag {name}, ich rufe im Auftrag von {clinic} an. Ich bin ein KI-Sprachassistent, und dieses Gespräch wird aufgezeichnet. Haben Sie ein paar Minuten Zeit für Ihre Anfrage?",
  ru: "Здравствуйте, {name}. Я звоню от имени {clinic}. Я голосовой ассистент на базе искусственного интеллекта, и этот разговор записывается. У вас есть несколько минут, чтобы обсудить ваш запрос?",
  ar: "مرحباً {name}، أتصل بكم نيابةً عن {clinic}. أنا مساعد صوتي يعمل بالذكاء الاصطناعي، وهذه المكالمة مسجّلة. هل لديكم بضع دقائق للحديث عن طلبكم؟",
  fr: "Bonjour {name}, je vous appelle de la part de {clinic}. Je suis un assistant vocal fonctionnant par intelligence artificielle et cet appel est enregistré. Avez-vous quelques minutes pour parler de votre demande ?",
  nl: "Goedendag {name}, ik bel namens {clinic}. Ik ben een AI-spraakassistent en dit gesprek wordt opgenomen. Heeft u een paar minuten om over uw aanvraag te praten?",
  pl: "Dzień dobry, {name}. Dzwonię w imieniu {clinic}. Jestem asystentem głosowym opartym na sztucznej inteligencji, a ta rozmowa jest nagrywana. Czy ma Pan/Pani kilka minut, aby porozmawiać o swoim zapytaniu?",
};

export const VOICE_LANGUAGES: readonly string[] = Object.keys(FIRST_MESSAGE);
const FALLBACK_LANGUAGE = "en";

/** Lead dilini aramada kullanılacak iki harfli koda çevirir; desteklenmeyen dilde İngilizce. */
export function voiceLanguage(language: string | null | undefined): string {
  const code = (language ?? "").trim().slice(0, 2).toLowerCase();
  return VOICE_LANGUAGES.includes(code) ? code : FALLBACK_LANGUAGE;
}

export function firstMessage(language: string, vars: { name: string; clinic: string }): string {
  const template = FIRST_MESSAGE[voiceLanguage(language)] ?? FIRST_MESSAGE[FALLBACK_LANGUAGE]!;
  return template.replace("{name}", vars.name.trim()).replace("{clinic}", vars.clinic.trim()).replace(/\s+,/g, ",");
}
