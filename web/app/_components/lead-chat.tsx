"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "../_lib/client-api";
import { formatDate } from "../_lib/format";
interface Message {
  id: string;
  sender: "user" | "bot" | "system" | "coordinator";
  content: string;
  createdAt: string;
  direction?: string;
  channel?: string;
}
export function LeadChat({ leadId }: { leadId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [escalated, setEscalated] = useState(false);
  const [conversationId, setConversationId] = useState<string>();
  const [escalating, setEscalating] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  async function loadMessages() {
    setLoading(true);
    try {
      const data = await api<{ conversations: { id: string; status: string; messages: (Message & { direction: string })[] }[] }>(
        `/api/conversations/${leadId}`,
      );
      const conversation = data.conversations[0];
      setConversationId(conversation?.id);
      setMessages((conversation?.messages ?? []).slice().reverse().map((msg) => ({
        ...msg, sender: msg.direction === "INCOMING" ? "user" : "bot",
      })));
      setEscalated(conversation?.status === "ESCALATED");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mesajlar yüklenemedi.");
    } finally {
      setLoading(false);
    }
  }
  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || !conversationId || escalated) return;
    setInput("");
    setError("");
    setLoading(true);
    try {
      await api(`/api/leads/${leadId}/messages`, "POST", {
        content: input.trim(), channel: "WHATSAPP",
      });
      await loadMessages();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mesaj gönderilemedi.");
    } finally {
      setLoading(false);
    }
  }
  async function escalate() {
    if (!conversationId) return;
    setEscalating(true);
    try {
      await api(`/api/conversations/${conversationId}/escalate`, "POST");
      setEscalated(true);
      await loadMessages();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Eskalasyon başarısız.");
    } finally {
      setEscalating(false);
    }
  }
  useEffect(() => {
    void loadMessages();
    const interval = setInterval(() => { void loadMessages(); }, 30000);
    return () => clearInterval(interval);
  }, [leadId]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);
  return (
    <section className="studio-card">
      <div className="section-kicker">MESAJLAR & AI DESTEK</div>
      <h2>Konuşma Geçmişi</h2>
      <p className="text-sm text-slate-500">WhatsApp Cloud API üzerinden iletilir (mock modda simüle edilir). Serbest metin 24 saatlik pencere içinde, dışında şablonla gönderilir.</p>
      {escalated && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          ⚠ Bu konuşma koordinatöre devredildi. Mesaj gönderilemez.
        </div>
      )}
      <div className="mb-4 flex h-80 flex-col gap-3 overflow-y-auto rounded-lg border border-slate-200 p-4" role="log" aria-live="polite">
        {messages.length === 0 && !loading ? (
          <p className="text-center text-sm text-slate-400">Henüz mesaj yok. Bir mesaj gönderin.</p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.sender === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[75%] rounded-lg px-4 py-2 text-sm ${
                msg.sender === "user" ? "bg-violet-500 text-white" :
                msg.sender === "coordinator" ? "bg-blue-100 text-blue-800" :
                msg.sender === "system" ? "bg-slate-100 text-slate-500" :
                "bg-slate-100 text-slate-800"
              }`}>
                <p className="whitespace-pre-wrap">{msg.content}</p>
                {msg.channel && <p className="text-[10px] opacity-60 mt-1">{msg.channel}</p>}
                <p className={`mt-1 text-[10px] ${msg.sender === "user" ? "text-violet-200" : "text-slate-400"}`}>
                  {formatDate(msg.createdAt)}
                </p>
              </div>
            </div>
          ))
        )}
        {loading && <div className="animate-pulse text-sm text-slate-400">Bot yanıtlandırıyor…</div>}
        <div ref={bottomRef} />
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-rose-600">{error}</p>}
      {!escalated && (
        <form onSubmit={sendMessage} className="flex gap-2 mb-2">
          <input className="field flex-1" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Mesaj yazın…" disabled={loading} />
          <button type="submit" className="primary-button" disabled={loading || !input.trim()}>Gönder</button>
        </form>
      )}
      <button
        className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 hover:bg-amber-100 disabled:opacity-50"
        disabled={escalated || !conversationId || escalating}
        onClick={() => void escalate()}
      >
        {escalating ? "Devrediliyor…" : "Koordinatöre Devret"}
      </button>
    </section>
  );
}
