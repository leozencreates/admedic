"use client";
import type { Ref } from "react";
import { t, type Language } from "../../_lib/i18n";
import type { PendingView } from "../../_lib/assistant/pending";

/**
 * Onay kartı (ADR-0028 §2 "Onay mekanizması", Faz 3). R1 aracı bekleyen bir eylem oluşturunca panelde görünür:
 * özet, "Onayla" ve "Vazgeç". "Onayla" sesli "evet" ile aynı yoldan (`runtime.pending.confirm`) geçer.
 * - Geri sayım görünür metindir (canlı bölge değil); eşik duyuruları üst bileşendeki ileti bölgesinden yapılır.
 * - Çalışırken düğmeler `disabled` değil `aria-disabled` olur: odaktaki düğme devre dışı kalınca odak kaybolmasın.
 * - Esc kartta eylemi iptal eder (oturumu kapatmaz).
 * - Düğmeler kartın gösterdiği `pendingId` ile çağırır: eylem bu arada değiştiyse üst bileşen tıklamayı yok sayar.
 * - Kart yeni açıldığında ya da eylem değiştiğinde "Onayla" kısa süre (`armed` false) etkin olmaz; yolda olan bir tuş
 *   vuruşu görülmemiş eylemi onaylamasın. Odak "Onayla"ya değil kart kabına (`tabIndex=-1`) taşınır.
 */
export function ConfirmCard({
  id,
  lang,
  pending,
  remaining,
  total,
  busy,
  armed = true,
  cardRef,
  confirmRef,
  onConfirm,
  onCancel,
}: {
  id: string;
  lang: Language;
  pending: PendingView;
  /** Kalan saniye. */
  remaining: number;
  /** Toplam süre (saniye); ilerleme çubuğu için. */
  total: number;
  busy: boolean;
  /** `false`: "Onayla" geçici olarak etkin değil (kart yeni açıldı/değişti). */
  armed?: boolean;
  cardRef?: Ref<HTMLDivElement>;
  confirmRef?: Ref<HTMLButtonElement>;
  onConfirm: (pendingId: string) => void;
  onCancel: (pendingId: string) => void;
}) {
  const confirmBlocked = busy || !armed;
  const titleId = `${id}-title`;
  const summaryId = `${id}-summary`;
  const pct = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;

  return (
    <div
      ref={cardRef}
      className="va-confirm"
      role="group"
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={summaryId}
      aria-busy={busy || undefined}
      data-risk={pending.risk}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onCancel(pending.pendingId);
      }}
    >
      <p id={titleId} className="va-confirm__title">
        {t("assistant.pending.title", lang)}
      </p>
      <p id={summaryId} className="va-confirm__summary">
        {pending.summary}
      </p>
      <p className="va-confirm__expires">
        {busy ? t("assistant.pending.applying", lang) : t("assistant.pending.expires", lang).replace("{seconds}", String(remaining))}
      </p>
      <div className="va-confirm__bar" aria-hidden="true">
        <span style={{ width: `${busy ? 100 : pct}%` }} />
      </div>
      <div className="va-confirm__actions">
        <button
          type="button"
          className="secondary-button"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onCancel(pending.pendingId);
          }}
        >
          {t("assistant.pending.cancel", lang)}
        </button>
        <button
          ref={confirmRef}
          type="button"
          className="primary-button"
          aria-disabled={confirmBlocked || undefined}
          onClick={() => {
            if (!confirmBlocked) onConfirm(pending.pendingId);
          }}
        >
          {t("assistant.pending.confirm", lang)}
        </button>
      </div>
    </div>
  );
}
