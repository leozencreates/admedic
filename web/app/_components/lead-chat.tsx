"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ApiError, api } from "../_lib/client-api";
import { formatDate, formatDay, formatDuration, formatRelative } from "../_lib/format";
import { channelLabel } from "../_lib/labels";

import { messageParty, type MessageParty as Party } from "../_lib/message-party";

export { messageParty };
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
  /** 24 saatlik mesajlaşma penceresi (sunucu hesaplar; kapalı konuşmada boş olabilir). */
  replyWindow?: ReplyWindow;
  messages: ApiMessage[];
}
interface ReplyWindow {
  lastInboundAt: string | null;
  endsAt: string | null;
  open: boolean;
}
type Conversation = Omit<ApiConversation, "messages">;
/** Konuşma okuma yetkisi olmayan rolde sunucunun 403 metni (`requireRole`). */
const TICK_MS = 60_000;
const WINDOW_WARN_MS = 2 * 3_600_000;

/** Kalan süre: "5 sa 12 dk", "38 dk", "1 dk'dan az". İstemci saati geride kalsa da 24 saati aşmaz. */
function remainingText(ms: number): string {
  return formatDuration(Math.min(ms, 24 * 3_600_000 - 60_000));
}

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
  /** Konuşmayı okuma yetkisi yok (403): yeniden deneme anlamsız. */
  const [forbidden, setForbidden] = useState(false);
  /** Hastaya yazabilir / devralabilir mi (sunucu `canReply`); bilinmiyorsa null. */
  const [canReply, setCanReply] = useState<boolean | null>(null);
  /** Pencere geri sayımı için istemci saati (dakikada bir güncellenir; SSR'de kullanılmaz). */
  const [now, setNow] = useState(0);
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
  const windowId = useId();

  const channel =
    conversation?.channel ??
    (leadChannel && MESSAGE_CHANNELS.includes(leadChannel) ? leadChannel : "WHATSAPP");
  const isWhatsApp = channel === "WHATSAPP";
  const isMetaChat = channel === "MESSENGER" || channel === "INSTAGRAM";
  const closed = conversation?.status === "CLOSED";
  const handoff = handoffView(conversation);
  const replyWindow: ReplyWindow = conversation?.replyWindow ?? { lastInboundAt: null, endsAt: null, open: false };
  const windowEndsAt = replyWindow.endsAt ? new Date(replyWindow.endsAt).getTime() : NaN;
  const remainingMs = Number.isFinite(windowEndsAt) && now > 0 ? windowEndsAt - now : NaN;
  // Sunucu açık dese de istemci saatinde süre dolduysa pencere kapalı sayılır.
  const windowOpen = replyWindow.open && !(remainingMs <= 0);
  /** WhatsApp'ta pencere dışında (ya da hasta hiç yazmadıysa) yalnızca onaylı şablon gönderilebilir. */
  const templateRequired = loaded && isWhatsApp && !closed && !windowOpen;
  const useTemplate = isWhatsApp && (templateMode || templateRequired);
  const canSend = useTemplate ? Boolean(templateName.trim()) : Boolean(input.trim());
  const showComposer = loaded && !closed && !forbidden && canReply !== false;
  const showHandoffActions = canReply === true;

  const loadMessages = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const data = await api<{ canReply?: boolean; conversations: ApiConversation[] }>(`/api/conversations/${leadId}`);
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
      setCanReply(data.canReply ?? true);
      setForbidden(false);
      setLoadFailed(false);
      setNow(Date.now());
    } catch (err) {
      if (seq < appliedSeq.current) return;
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
        setCanReply(false);
      }
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

  // Yanıt penceresinin kalan süresi dakikada bir güncellenir.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

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
      setSendError(err instanceof Error ? err.message : "Mesaj gönderilemedi. Bağlantınızı kontrol edip tekrar deneyin.");
    } finally {
      setSending(false);
    }
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter gönderir, Shift+Enter yeni satır; yazı birleştirme (IME) sırasında Enter'a dokunulmaz.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Şablon modunda alan yalnızca panel notudur; şablon düğmeyle gönderilir.
    if (useTemplate) return;
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
      setHandoffError(err instanceof Error ? err.message : "Konuşma devralınamadı. Konuşmanın güncel durumuna bakıp tekrar deneyin.");
    } finally {
      // Başarıda da çakışmada (409) da güncel durum gösterilir.
      await loadMessages();
      setHandoffBusy(false);
    }
  }

  /** Yazma alanının üstündeki tek satırlık 24 saatlik pencere göstergesi. */
  function windowNotice(): { text: string; tone: string } | null {
    if (!loaded || closed || !(isWhatsApp || isMetaChat)) return null;
    if (windowOpen) {
      if (!Number.isFinite(remainingMs)) return { text: "Yanıt penceresi açık.", tone: "text-ink-3" };
      return {
        text: `Yanıt penceresi açık · ${remainingText(remainingMs)} sonra kapanır`,
        tone: remainingMs < WINDOW_WARN_MS ? "text-amber-800" : "text-ink-3",
      };
    }
    if (isMetaChat) return { text: "24 saatlik pencere kapandı; mesaj insan temsilci etiketiyle gönderilir.", tone: "text-ink-3" };
    if (!replyWindow.lastInboundAt)
      return { text: "Hasta henüz yazmadı; ilk mesaj yalnızca onaylı şablonla gönderilebilir.", tone: "text-amber-800" };
    return {
      text: `Yanıt penceresi kapandı (son hasta mesajı: ${formatDate(replyWindow.lastInboundAt)}). Yalnızca onaylı şablonla yazabilirsiniz.`,
      tone: "text-amber-800",
    };
  }
  const notice = windowNotice();

  const stripTone =
    handoff.kind === "unclaimed" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-line bg-surface text-ink-2";

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby={headingId}>
      <h2 id={headingId} className="sr-only">
        Konuşma
      </h2>
      {/* Durum şeridi: kanal + devir durumu ve Devral düğmesi. */}
      <div className={`flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-2 text-sm ${stripTone}`}>
        <p className="min-w-0" aria-live="polite">
          <span className="font-medium text-ink">{channelLabel(channel)}</span>
          {handoff.kind !== "none" && (
            <>
              <span aria-hidden="true" className="text-ink-3">
                {" · "}
              </span>
              <span>{handoff.text}</span>
            </>
          )}
        </p>
        {showHandoffActions && handoff.kind === "unclaimed" && (
          <button type="button" className="primary-button" disabled={handoffBusy} onClick={() => void takeOver()}>
            {handoffBusy ? "Devralınıyor…" : "Devral"}
          </button>
        )}
        {showHandoffActions && handoff.kind === "active" && (
          <button type="button" className="secondary-button" disabled={handoffBusy} onClick={() => void takeOver()}>
            {handoffBusy ? "Devralınıyor…" : "Konuşmayı devral"}
          </button>
        )}
      </div>
      {handoffError && (
        <p role="alert" className="shrink-0 border-b border-line px-4 py-2 text-sm text-rose-700">
          {handoffError}
        </p>
      )}

      {!loaded ? (
        <p role="status" className="flex flex-1 items-center justify-center p-6 text-sm text-muted">
          Mesajlar yükleniyor…
        </p>
      ) : forbidden ? (
        <p role="alert" className="flex flex-1 items-center justify-center p-6 text-center text-sm text-ink-2">
          Bu konuşmanın mesajlarını görme yetkiniz yok. Erişim gerekiyorsa hesap yöneticinize başvurun.
        </p>
      ) : (
        <div
          ref={logRef}
          role="log"
          aria-label="Mesajlar"
          tabIndex={0}
          onScroll={onLogScroll}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4"
        >
          {messages.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              Henüz mesaj yok. Hasta yazdığında ya da siz ilk mesajı gönderdiğinizde konuşma burada görünür.
            </p>
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
      {loadFailed && !forbidden && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-3 border-t border-line px-4 py-2 text-sm text-rose-700">
          <span>
            {messages.length
              ? "Mesajlar güncellenemedi. Bağlantınızı kontrol edip tekrar deneyin."
              : "Mesajlar yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin."}
          </span>
          <button type="button" className="secondary-button" onClick={() => void loadMessages()}>
            Tekrar dene
          </button>
        </div>
      )}

      {loaded && !forbidden && canReply === false && !closed && (
        <p className="shrink-0 border-t border-line bg-surface px-4 py-3 text-sm text-ink-3">
          Hastaya yalnızca hesap sahibi, yönetici ve hasta koordinatörü yazabilir.
        </p>
      )}

      {showComposer && (
        <form onSubmit={sendMessage} className="shrink-0 space-y-2 border-t border-line bg-surface px-3 py-3 sm:px-4">
          {notice && (
            <p id={windowId} className={`text-xs ${notice.tone}`}>
              {notice.text}
            </p>
          )}
          {isWhatsApp && (
            <label className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
              <input
                type="checkbox"
                checked={useTemplate}
                disabled={templateRequired}
                aria-describedby={templateRequired && notice ? windowId : undefined}
                onChange={(e) => setTemplateMode(e.target.checked)}
              />
              Onaylı şablonla gönder
              {templateRequired && <span className="text-xs text-ink-3">(pencere kapalıyken zorunlu)</span>}
            </label>
          )}
          {useTemplate && (
            <div className="grid gap-2 sm:grid-cols-2">
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
          <div className="flex items-end gap-2">
            <label className="field min-w-0 flex-1">
              <span className={useTemplate ? undefined : "sr-only"}>
                {useTemplate ? "Panelde görünecek not (isteğe bağlı, hastaya gönderilmez)" : "Yanıt"}
              </span>
              <textarea
                ref={composerRef}
                className="input field-sizing-content max-h-[8.5rem] min-h-14 resize-none"
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onComposerKeyDown}
                aria-describedby={useTemplate ? undefined : hintId}
                placeholder={useTemplate ? undefined : "Yanıt yazın…"}
                dir="auto"
              />
            </label>
            <button type="submit" className="primary-button shrink-0" disabled={sending || !canSend}>
              {sending ? "Gönderiliyor…" : useTemplate ? "Şablonu gönder" : "Gönder"}
            </button>
          </div>
          {!useTemplate ? (
            <p id={hintId} className="hidden text-xs text-muted [@media(pointer:fine)]:block">
              Klavyede Enter gönderir, Shift+Enter yeni satır açar.
            </p>
          ) : null}
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
