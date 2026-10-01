"use client";
import { useEffect, useRef, useState, type Ref } from "react";
import { Send, X } from "lucide-react";
import { t, type Language } from "../../_lib/i18n";
import { Orb } from "./orb";
import type { AssistantUiState, TranscriptLine } from "./state";

/**
 * Asistan paneli (ADR-0028 §4): durum, son konuşma satırları (yalnızca bellekte), metin kutusu ve bitir düğmesi.
 * Metin kutusu her zaman vardır; mikrofon yoksa ya da izin reddedildiyse aynı ajan metinle çalışır
 * (`sendUserMessage`). Esc oturumu bitirir.
 */
export function AssistantPanel({
  id,
  lang,
  assistantName,
  state,
  stateText,
  lines,
  notice,
  error,
  canSend,
  inputRef,
  getLevel,
  onSend,
  onEnd,
  onRetry,
}: {
  id: string;
  lang: Language;
  assistantName: string;
  state: AssistantUiState;
  stateText: string;
  lines: TranscriptLine[];
  notice: string;
  error: string;
  canSend: boolean;
  inputRef?: Ref<HTMLInputElement>;
  getLevel?: () => number;
  onSend: (text: string) => void;
  onEnd: () => void;
  onRetry: () => void;
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLOListElement>(null);

  // Yeni satır gelince liste en alta kayar.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !canSend) return;
    onSend(text);
    setDraft("");
  }

  const inputId = `${id}-input`;
  const titleId = `${id}-title`;

  return (
    <section
      id={id}
      className="va-panel"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onEnd();
        }
      }}
    >
      <header className="va-panel__head">
        <Orb state={state} getLevel={getLevel} size={18} />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="va-panel__title">
            {assistantName}
          </h2>
          <p className="va-panel__state" data-state={state}>
            {stateText}
          </p>
        </div>
        <button type="button" className="va-panel__close" aria-label={t("assistant.end", lang)} onClick={onEnd}>
          <X size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>

      {lines.length > 0 ? (
        <ol ref={listRef} className="va-panel__lines" aria-label={t("assistant.transcript", lang)}>
          {lines.map((line) => (
            <li key={line.id} className="va-line" data-role={line.role}>
              <span className="va-line__who">{line.role === "user" ? t("assistant.you", lang) : assistantName}</span>
              <span className="va-line__text">{line.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="va-panel__hint">{t("assistant.hint", lang)}</p>
      )}

      {notice ? <p className="va-panel__notice">{notice}</p> : null}

      {error ? (
        <div className="va-panel__error">
          <p>{error}</p>
          <button type="button" className="secondary-button" onClick={onRetry}>
            {t("assistant.retry", lang)}
          </button>
        </div>
      ) : null}

      <form className="va-panel__form" onSubmit={submit}>
        <label htmlFor={inputId} className="sr-only">
          {t("assistant.inputLabel", lang)}
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          enterKeyHint="send"
          autoComplete="off"
          maxLength={500}
          value={draft}
          disabled={!canSend}
          placeholder={t("assistant.inputPlaceholder", lang)}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="va-panel__send" aria-label={t("assistant.send", lang)} disabled={!canSend || !draft.trim()}>
          <Send size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </form>
    </section>
  );
}
