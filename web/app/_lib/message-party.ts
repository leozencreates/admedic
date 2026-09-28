/** Mesajın kimden geldiği (saf; sunucu ve istemci ortak). */
export type MessageParty = "lead" | "assistant" | "team" | "system";

/** Giden mesaj: sender boş/"ai"/"bot" → asistan, "system" → sistem notu, aksi halde ekip üyesi (kullanıcı kimliği). */
export function messageParty(msg: { direction: string; sender?: string | null }): MessageParty {
  if (msg.direction === "INCOMING") return "lead";
  const sender = (msg.sender ?? "").trim().toLowerCase();
  if (!sender || sender === "ai" || sender === "bot") return "assistant";
  if (sender === "system") return "system";
  return "team";
}
