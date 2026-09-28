"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api } from "../_lib/client-api";
import { formatDate, formatDay, formatRelative } from "../_lib/format";
import { channelLabel } from "../_lib/labels";

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
/** GET /api/conversations/:leadId satırı (devir alanlarıyla). */
interface ApiConversation {
  id: string;
  status: string;
  channel: string;
  escalatedTo?: string | null;
  escalatedAt?: string | null;
  escalatedToName?: string | null;
  escalatedToIsMe?: boolean;
  messages: ApiMessage[];
}
type Conversation = Omit<ApiConversation, "messages">;

const MESSAGE_CHANNELS = ["WHATSAPP", "INSTAGRAM", "MESSENGER", "SMS"];
const PARTY_LABEL: Record<Party, string> = {
  lead: "Hasta adayı",
  assistant: "Karşılama asistanı",
  team: "Ekip",
  system: "Sistem",
};
/** Hasta solda nötr; ekip sağda marka renginde; asistan sağda açık tonda (etiket ve saat ≥12 px, kontrast ≥4,5:1). */
const BUBBLE: Record<Exclude<Party, "system">, { box: string; meta: string }> = {
  lead: { box: "bg-slate-100 text-slate-900", meta: "text-muted" },
  team: { box: "bg-brand-strong text-white", meta: "text-violet-100" },
  assistant: { box: "bg-violet-50 text-slate-900 ring-1 ring-inset ring-violet-200", meta: "text-pill" },
};
/** Kullanıcı mesaj listesinin sonuna bu kadar yakınsa yeni mesaj geldiğinde liste sona kaydırılır. */
const NEAR_BOTTOM_PX = 64;
const REFRESH_MS = 30_000;
const WEEK_MS = 7 * 86_400_000;

/** Giden mesajın kimden geldiği: sender boş/"ai"/"bot" → asistan, "system" → sistem notu, aksi halde ekip. */
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

/** Sistem notu metni; eski kayıtların başındaki uyarı simgesi ("⚠") gösterilmez. */
export function systemNoteText(content: string): string {
  return content.replace(/^\s*⚠️?\s*/u, "");
}

export type HandoffView =
  | { kind: "unclaimed"; text: string }
  | { kind: "claimed"; text: string }
  | { kind: "active"; text: string }
  | { kind: "closed"; text: string }
  | { kind: "none" };

/**
 * Devir durumu (Faz 1 "devir gerçeği"): ESCALATED + `escalatedTo` boş = asistan devretti, kimse
 * devralmadı (eylem bekleniyor); dolu = bir ekip üyesi devraldı. Göreli zaman yalnızca istemcide üretilir.
 */
export function handoffView(conversation: Conversation | undefined, now: Date = new Date()): HandoffView {
  if (!conversation) return { kind: "none" };
  if (conversation.status === "ACTIVE") return { kind: "active", text: "Karşılama asistanı yanıtlıyor." };
  if (conversation.status === "CLOSED")
    return { kind: "closed", text: "Bu konuşma kapatıldı; yeni mesaj gönderilemez." };
  if (conversation.status !== "ESCALATED") return { kind: "none" };
  if (!conversation.escalatedTo) {
    const at = conversation.escalatedAt ? new Date(conversation.escalatedAt) : null;
    const when =
      at && !Number.isNaN(at.getTime())
        ? now.getTime() - at.getTime() > WEEK_MS
          ? `${formatDay(at)} tarihinde `
          : `${formatRelative(at, now)} `
        : "";
    return { kind: "unclaimed", text: `Asistan konuşmayı ${when}devretti; henüz kimse devralmadı.` };
  }
  if (conversation.escalatedToIsMe) return { kind: "claimed", text: "Konuşmayı siz devraldınız." };
  return {
    kind: "claimed",
    text: `${conversation.escalatedToName?.trim() || "Bir ekip üyesi"} devraldı; asistan susturuldu.`,
  };
}

export function LeadChat({
  leadId,
  leadChannel,
  leadName,
}: {
  leadId: string;
  leadChannel?: string | null;
  /** Hasta mesajlarının etiketi; verilmezse "Hasta adayı". */
  leadName?: string | null;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<Conversation>();
  /** İlk yükleme bitti mi (arka plan yenilemesi yükleniyor göstermez). */
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState("");
  const [templateMode, setTemplateMode] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateParams, setTemplateParams] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const lastMessageId = useRef<string | null>(null);
  /** Yanıtlar sırasız gelebilir: eski yanıt, daha yenisi uygulandıktan sonra gelirse atılır. */
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  const headingId = useId();
  const hintId = useId();

  const channel =
    conversation?.channel ??
    (leadChannel && MESSAGE_CHANNELS.includes(leadChannel) ? leadChannel : "WHATSAPP");
  const isWhatsApp = channel === "WHATSAPP";
  const closed = conversation?.status === "CLOSED";
  const handoff = handoffView(conversation);
  const useTemplate = templateMode && isWhatsApp;
  const canSend = useTemplate ? Boolean(templateName.trim()) : Boolean(input.trim());

  const loadMessages = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const data = await api<{ conversations: ApiConversation[] }>(`/api/conversations/${leadId}`);
      if (seq < appliedSeq.current) return; // daha yeni bir yanıt zaten gösteriliyor
      appliedSeq.current = seq;
      // Açık (ACTIVE/ESCALATED) konuşma öncelikli; yoksa en son konuşma.
      const current = data.conversations.find((c) => c.status !== "CLOSED") ?? data.conversations[0];
      if (current) {
        const { messages: rows, ...rest } = current;
        setConversation(rest);
        setMessages(rows.slice().reverse().map((msg) => ({ ...msg, party: messageParty(msg) })));
      } else {
        setConversation(undefined);
        setMessages([]);
      }
      setLoadFailed(false);
    } catch {
      if (seq < appliedSeq.current) return;
      setLoadFailed(true);
    }
    setLoaded(true);
  }, [leadId]);

  useEffect(() => {
    void loadMessages();
    // Sekme görünürken sessizce yenilenir; sekmeye dönülünce hemen yenilenir.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadMessages();
    }, REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void loadMessages();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadMessages]);

  // Yalnızca mesaj kutusu kayar (pencere asla): yeni mesaj geldiğinde ve kullanıcı zaten sondaysa.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const lastId = messages.length ? messages[messages.length - 1].id : null;
    if (lastId === lastMessageId.current) return;
    lastMessageId.current = lastId;
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, loaded]);

  function onLogScroll() {
    const el = logRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }

  async function sendMessage(e?: React.FormEvent) {
    e?.preventDefault();
    if (closed || sending || !canSend) return;
    const content = input.trim();
    const template = useTemplate ? templateName.trim() : "";
    setSendError("");
    setSending(true);
    try {
      await api(`/api/leads/${leadId}/messages`, "POST", {
        content,
        channel,
        ...(template ? { templateName: template, templateParams: parseTemplateParams(templateParams) } : {}),
      });
      setInput("");
      if (template) {
        setTemplateName("");
        setTemplateParams("");
      }
      stickToBottom.current = true;
      await loadMessages();
      composerRef.current?.focus({ preventScroll: true });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Mesaj gönderilemedi. Tekrar deneyin.");
    } finally {
      setSending(false);
    }
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter gönderir, Shift+Enter yeni satır; yazı birleştirme (IME) sırasında Enter'a dokunulmaz.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Dokunmatik ekranda Enter yeni satırdır; gönderim düğmeyle yapılır (yanlışlıkla gönderimi önler).
    if (window.matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    void sendMessage();
  }

  async function takeOver() {
    if (!conversation) return;
    setHandoffBusy(true);
    setHandoffError("");
    try {
      await api(`/api/conversations/${conversation.id}/escalate`, "POST", {});
      stickToBottom.current = true;
    } catch (err) {
      setHandoffError(err instanceof Error ? err.message : "Konuşma devralınamadı. Tekrar deneyin.");
    } finally {
      // Başarıda da çakışmada (409) da güncel durum gösterilir.
      await loadMessages();
      setHandoffBusy(false);
    }
  }

  return (
    <section className="studio-card" aria-labelledby={headingId}>
      <div className="section-kicker">Mesajlar</div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId}>Konuşma</h2>
        <p className="text-sm text-muted">Kanal: {channelLabel(channel)}</p>
      </div>

      {handoff.kind === "unclaimed" && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p>{handoff.text}</p>
          <button type="button" className="primary-button" disabled={handoffBusy} onClick={() => void takeOver()}>
            {handoffBusy ? "Devralınıyor…" : "Devral"}
          </button>
        </div>
      )}
      {handoff.kind === "active" && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          <p>{handoff.text}</p>
          <button type="button" className="secondary-button" disabled={handoffBusy} onClick={() => void takeOver()}>
            {handoffBusy ? "Devralınıyor…" : "Konuşmayı devral"}
          </button>
        </div>
      )}
      {(handoff.kind === "claimed" || handoff.kind === "closed") && (
        <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{handoff.text}</p>
      )}
      {handoffError && (
        <p role="alert" className="mt-2 text-sm text-rose-700">
          {handoffError}
        </p>
      )}

      {isWhatsApp && !closed && (
        <p className="mt-3 text-sm text-muted">
          WhatsApp&apos;ta son mesajın üzerinden 24 saat geçtiyse yalnızca onaylı şablon gönderebilirsiniz.
        </p>
      )}

      {!loaded ? (
        <p role="status" className="mt-4 text-sm text-muted">
          Mesajlar yükleniyor…
        </p>
      ) : (
        <div
          ref={logRef}
          role="log"
          aria-label="Mesajlar"
          tabIndex={0}
          onScroll={onLogScroll}
          className="mt-4 max-h-[min(60vh,32rem)] min-h-48 overflow-y-auto rounded-lg border border-slate-200 p-3 sm:p-4"
        >
          {messages.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">Henüz mesaj yok.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {messages.map((msg) =>
                msg.party === "system" ? (
                  <li key={msg.id} className="px-2 text-center text-xs text-muted">
                    {systemNoteText(msg.content)}
                    <span aria-hidden="true"> · </span>
                    <time dateTime={msg.createdAt}>{formatDate(msg.createdAt)}</time>
                  </li>
                ) : (
                  <li key={msg.id} className={`flex ${msg.party === "lead" ? "justify-start" : "justify-end"}`}>
                    <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm sm:max-w-[75%] ${BUBBLE[msg.party].box}`}>
                      <p className={`text-xs font-semibold ${BUBBLE[msg.party].meta}`}>
                        {msg.party === "lead" && leadName?.trim() ? leadName : PARTY_LABEL[msg.party]}
                      </p>
                      <p className="whitespace-pre-wrap break-words" dir="auto">
                        {msg.content}
                      </p>
                      <p className={`mt-1 text-xs ${BUBBLE[msg.party].meta}`}>
                        <time dateTime={msg.createdAt}>{formatDate(msg.createdAt)}</time>
                      </p>
                    </div>
                  </li>
                ),
              )}
            </ol>
          )}
        </div>
      )}
      {loadFailed && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 text-sm text-rose-700">
          <span>
            {messages.length
              ? "Mesajlar güncellenemedi. Bağlantınızı kontrol edin."
              : "Mesajlar yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin."}
          </span>
          <button type="button" className="secondary-button" onClick={() => void loadMessages()}>
            Tekrar dene
          </button>
        </div>
      )}

      {!closed && (
        <form onSubmit={sendMessage} className="mt-4 space-y-3">
          {isWhatsApp && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={templateMode} onChange={(e) => setTemplateMode(e.target.checked)} />
              Onaylı şablonla gönder
            </label>
          )}
          {useTemplate && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field">
                Meta&apos;da onaylı şablon adı
                <input
                  className="input"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="örn. hosgeldiniz_tr"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                Şablon değişkenleri (virgülle)
                <input
                  className="input"
                  value={templateParams}
                  onChange={(e) => setTemplateParams(e.target.value)}
                  placeholder="örn. Ayşe, 12:00"
                  autoComplete="off"
                />
              </label>
            </div>
          )}
          <label className="field">
            {useTemplate ? "Panelde görünecek not (isteğe bağlı, hastaya gönderilmez)" : "Yanıt"}
            <textarea
              ref={composerRef}
              className="input"
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKeyDown}
              aria-describedby={hintId}
              dir="auto"
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p id={hintId} className="text-xs text-muted">
              Klavyede Enter gönderir, Shift+Enter yeni satır açar.
            </p>
            <button type="submit" className="primary-button" disabled={sending || !canSend}>
              {sending ? "Gönderiliyor…" : useTemplate ? "Şablonu gönder" : "Gönder"}
            </button>
          </div>
          {sendError && (
            <p role="alert" className="text-sm text-rose-700">
              {sendError}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
