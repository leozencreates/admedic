"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../_lib/client-api";
import { formatDate } from "../_lib/format";

type Party = "lead" | "assistant" | "team" | "system";
interface ApiMessage {
  id: string;
  content: string;
  createdAt: string;
  direction: string;
  channel?: string;
  sender?: string | null;
}
interface Message extends ApiMessage {
  party: Party;
}
interface ApiConversation {
  id: string;
  status: string;
  channel: string;
  messages: ApiMessage[];
}

const MESSAGE_CHANNELS = ["WHATSAPP", "INSTAGRAM", "MESSENGER", "SMS"];
const PARTY_LABEL: Record<Party, string> = {
  lead: "Hasta adayı",
  assistant: "Asistan",
  team: "Ekip",
  system: "Sistem",
};

/** Giden mesajın kimden geldiği: sender boş/"ai"/"bot" → Asistan, "system" → Sistem, aksi halde Ekip. */
export function messageParty(msg: { direction: string; sender?: string | null }): Party {
  if (msg.direction === "INCOMING") return "lead";
  const sender = (msg.sender ?? "").trim().toLowerCase();
  if (!sender || sender === "ai" || sender === "bot") return "assistant";
  if (sender === "system") return "system";
  return "team";
}

/** Virgülle ayrılmış şablon parametrelerini {1: "...", 2: "..."} biçimine çevirir. */
export function parseTemplateParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((value, index) => {
      out[String(index + 1)] = value;
    });
  return out;
}

export function LeadChat({ leadId, leadChannel }: { leadId: string; leadChannel?: string | null }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [conversation, setConversation] = useState<{ id: string; status: string; channel: string }>();
  const [escalating, setEscalating] = useState(false);
  const [templateMode, setTemplateMode] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateParams, setTemplateParams] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const channel =
    conversation?.channel ??
    (leadChannel && MESSAGE_CHANNELS.includes(leadChannel) ? leadChannel : "WHATSAPP");
  const status = conversation?.status;
  const closed = status === "CLOSED";
  const escalated = status === "ESCALATED";

  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ conversations: ApiConversation[] }>(`/api/conversations/${leadId}`);
      // Açık (ACTIVE/ESCALATED) konuşma öncelikli; yoksa en son konuşma.
      const current = data.conversations.find((c) => c.status !== "CLOSED") ?? data.conversations[0];
      setConversation(current ? { id: current.id, status: current.status, channel: current.channel } : undefined);
      setMessages(
        (current?.messages ?? [])
          .slice()
          .reverse()
          .map((msg) => ({ ...msg, party: messageParty(msg) })),
      );
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mesajlar yüklenemedi.");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const content = input.trim();
    const template = templateName.trim();
    if (closed) return;
    if (!content && !(templateMode && template)) return;
    setError("");
    setSending(true);
    try {
      await api(`/api/leads/${leadId}/messages`, "POST", {
        content,
        channel,
        ...(templateMode && template
          ? { templateName: template, templateParams: parseTemplateParams(templateParams) }
          : {}),
      });
      setInput("");
      await loadMessages();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mesaj gönderilemedi.");
    } finally {
      setSending(false);
    }
  }

  async function escalate() {
    if (!conversation) return;
    setEscalating(true);
    try {
      await api(`/api/conversations/${conversation.id}/escalate`, "POST");
      await loadMessages();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Devralma başarısız.");
    } finally {
      setEscalating(false);
    }
  }

  useEffect(() => {
    void loadMessages();
    const interval = setInterval(() => { void loadMessages(); }, 30000);
    return () => clearInterval(interval);
  }, [loadMessages]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const bubbleClass = (party: Party) =>
    party === "lead"
      ? "bg-violet-500 text-white"
      : party === "team"
        ? "bg-blue-100 text-blue-800"
        : party === "system"
          ? "bg-slate-100 text-slate-500"
          : "bg-slate-100 text-slate-800";

  return (
    <section className="studio-card">
      <div className="section-kicker">MESAJLAR & AI DESTEK</div>
      <h2>Konuşma Geçmişi</h2>
      <p className="text-sm text-slate-500">
        Kanal: <strong>{channel}</strong>. WhatsApp&apos;ta serbest metin 24 saatlik pencere içinde, dışında onaylı şablonla gönderilir;
        Messenger/Instagram&apos;da pencere dışı gönderim HUMAN_AGENT etiketiyle yapılır (mock modda simüle edilir).
      </p>
      {escalated && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          ⚠ Bu konuşma ekip tarafından devralındı; asistan susturuldu. Yazdığınız mesajlar ekip adına gönderilir.
        </div>
      )}
      {closed && (
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          Bu konuşma kapatıldı; yeni mesaj gönderilemez.
        </div>
      )}
      <div className="mb-4 flex h-80 flex-col gap-3 overflow-y-auto rounded-lg border border-slate-200 p-4" role="log" aria-live="polite">
        {messages.length === 0 && !loading ? (
          <p className="text-center text-sm text-slate-400">Henüz mesaj yok. Bir mesaj gönderin.</p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.party === "lead" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[75%] rounded-lg px-4 py-2 text-sm ${bubbleClass(msg.party)}`}>
                <p className={`text-[10px] font-semibold uppercase tracking-wide ${msg.party === "lead" ? "text-violet-200" : "opacity-70"}`}>
                  {PARTY_LABEL[msg.party]}
                </p>
                <p className="whitespace-pre-wrap">{msg.content}</p>
                {msg.channel && <p className="text-[10px] opacity-60 mt-1">{msg.channel}</p>}
                <p className={`mt-1 text-[10px] ${msg.party === "lead" ? "text-violet-200" : "text-slate-400"}`}>
                  {formatDate(msg.createdAt)}
                </p>
              </div>
            </div>
          ))
        )}
        {loading && <div className="animate-pulse text-sm text-slate-400">Yükleniyor…</div>}
        <div ref={bottomRef} />
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-rose-600">{error}</p>}
      {!closed && (
        <form onSubmit={sendMessage} className="mb-2 space-y-2">
          <div className="flex gap-2">
            <input
              className="field flex-1"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={templateMode ? "Şablon için isteğe bağlı açıklama…" : "Mesaj yazın…"}
              disabled={sending}
            />
            <button
              type="submit"
              className="primary-button"
              disabled={sending || (!input.trim() && !(templateMode && templateName.trim()))}
            >
              {sending ? "Gönderiliyor…" : "Gönder"}
            </button>
          </div>
          {channel === "WHATSAPP" && (
            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2 text-slate-600">
                <input type="checkbox" checked={templateMode} onChange={(e) => setTemplateMode(e.target.checked)} />
                Şablonla gönder (24 saatlik pencere dışı)
              </label>
              {templateMode && (
                <div className="flex flex-wrap gap-2">
                  <input
                    className="field flex-1 min-w-[180px]"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="Şablon adı (örn. hosgeldiniz_tr)"
                    aria-label="Şablon adı"
                  />
                  <input
                    className="field flex-1 min-w-[180px]"
                    value={templateParams}
                    onChange={(e) => setTemplateParams(e.target.value)}
                    placeholder="Parametreler (virgülle: Ayşe, 12:00)"
                    aria-label="Şablon parametreleri"
                  />
                </div>
              )}
            </div>
          )}
        </form>
      )}
      <button
        className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 hover:bg-amber-100 disabled:opacity-50"
        disabled={escalated || closed || !conversation || escalating}
        onClick={() => void escalate()}
      >
        {escalating ? "Devralınıyor…" : escalated ? "Devralındı" : "Konuşmayı Devral"}
      </button>
    </section>
  );
}
