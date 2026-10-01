"use client";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { t, type Language } from "../../_lib/i18n";
import type { ConfirmationView, PendingView } from "../../_lib/assistant/pending";
import { Dialog } from "../dialog";
import { CONFIRM_ARM_MS, screenClickAllowed, screenConfirmLabelKey } from "./state";

/**
 * Ekrandaki modal onay penceresi (ADR-0028 §2 "Onay mekanizması", Faz 4). Dış etkisi (R2) ya da harcaması (R3) olan
 * bekleyen eylem **yalnızca** burada, kullanıcının gerçek tıklamasıyla onaylanır (`runtime.pending.confirmOnScreen`).
 * Sesli "evet", `confirm_pending_action` ve R1 onay kartı bunu çalıştıramaz; ajan bu pencereye erişemez.
 * - Ortak `Dialog` (`<dialog>` + `showModal`): odak pencerede tutulur, sayfa inert olur, Esc ve arka plan tıklaması
 *   iptal eder (işlem sürerken yok sayılır); kapanınca odak açan öğeye döner.
 * - Açılınca (ve eylem değişince) odak "Vazgeç"e konur; "Onayla" en az `CONFIRM_ARM_MS` boyunca `aria-disabled` kalır.
 *   Yolda olan bir Enter/tıklama görülmemiş eylemi onaylamaz.
 * - "Onayla" yalnızca tarayıcının ürettiği (`isTrusted`) ve düğme etkinken başlamış bir tıklamayı kabul eder.
 * - Risk rozeti yalnızca renkle değil metinle de belirtilir; R3'te harcama uyarısı ve "Harcamayı onayla" etiketi.
 * - Sayfanın geri kalanı inert olduğundan geri sayım eşikleri pencerenin kendi canlı bölgesinden duyurulur.
 */
export function ScreenConfirmDialog({
  id,
  lang,
  pending,
  confirmation,
  remaining,
  total,
  busy,
  announcement,
  onConfirm,
  onCancel,
}: {
  id: string;
  lang: Language;
  /** Gösterilen ekran eylemi; `null` iken pencere kapalıdır (bileşen hep çizili kalır ki `close()` odağı geri versin). */
  pending: PendingView | null;
  confirmation: ConfirmationView | null;
  /** Kalan saniye. */
  remaining: number;
  /** Toplam süre (saniye); ilerleme çubuğu için. */
  total: number;
  busy: boolean;
  /** Pencere içi canlı bölge (geri sayım eşikleri, yerine yeni eylem gelmesi); `seq` aynı metni yeniden duyurur. */
  announcement?: { text: string; seq: number };
  /** Yalnızca gerçek bir tıklamadan; `trusted` olayın `isTrusted` değeridir (üst bileşen yeniden denetler). */
  onConfirm: (pendingId: string, trusted: boolean) => void;
  onCancel: (pendingId: string) => void;
}) {
  const pendingId = pending && confirmation ? pending.pendingId : null;
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const armed = armedFor === pendingId;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pressStartedArmed = useRef(false);

  // Her yeni eylemde: "Onayla" önce etkin değil, en az CONFIRM_ARM_MS sonra etkinleşir; odak "Vazgeç"e.
  // (Zamanlayıcı `showModal`'dan sonra çalışır: üst `Dialog` etkisi alt bileşeninkinden sonra çalışır.)
  useEffect(() => {
    pressStartedArmed.current = false;
    if (!pendingId) return;
    const focusTimer = window.setTimeout(() => cancelRef.current?.focus(), 0);
    const armTimer = window.setTimeout(() => setArmedFor(pendingId), CONFIRM_ARM_MS);
    return () => {
      window.clearTimeout(focusTimer);
      window.clearTimeout(armTimer);
    };
  }, [pendingId]);

  const confirmBlocked = busy || !armed;
  const pct = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  const armingId = `${id}-arming`;
  if (!pending || !confirmation || !pendingId) return <Dialog open={false} title="" onClose={() => undefined} />;
  const notes = confirmation.notes ?? [];

  return (
    <Dialog
      open
      title={confirmation.title}
      description={pending.summary}
      onClose={() => {
        if (!busy) onCancel(pendingId);
      }}
      footer={
        <>
          {/* "Vazgeç" DOM'da önce gelir: `showModal` odağı da buraya koyar. */}
          <button
            ref={cancelRef}
            type="button"
            className="secondary-button va-screen__button"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onCancel(pendingId);
            }}
          >
            {t("assistant.pending.cancel", lang)}
          </button>
          <button
            type="button"
            className={`${confirmation.risk === "R3" ? "danger-button" : "primary-button"} va-screen__button`}
            aria-disabled={confirmBlocked || undefined}
            aria-describedby={!armed && !busy ? armingId : undefined}
            onPointerDown={() => {
              pressStartedArmed.current = armed && !busy;
            }}
            onClick={(e) => {
              const allowed = screenClickAllowed({
                trusted: e.nativeEvent.isTrusted,
                armed,
                busy,
                // Klavyeyle etkinleştirmede `detail` 0'dır.
                fromPointer: e.detail > 0,
                pressStartedArmed: pressStartedArmed.current,
              });
              pressStartedArmed.current = false;
              if (allowed) onConfirm(pendingId, e.nativeEvent.isTrusted);
            }}
          >
            {busy ? t("assistant.pending.applying", lang) : t(screenConfirmLabelKey(confirmation.risk), lang)}
          </button>
        </>
      }
    >
      <div className="va-screen" data-risk={confirmation.risk} aria-busy={busy || undefined}>
        <p className="va-screen__risk" data-risk={confirmation.risk}>
          <ShieldAlert size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{t("assistant.screen.riskPrefix", lang)}</span> <strong>{confirmation.riskLabel}</strong>
        </p>

        <dl className="va-screen__fields">
          {confirmation.campaignName ? (
            <div className="va-screen__row">
              <dt>{t("assistant.screen.field.campaign", lang)}</dt>
              <dd>
                <strong>{confirmation.campaignName}</strong>
              </dd>
            </div>
          ) : null}
          {confirmation.fields.map((field, i) => (
            <div key={`${i}-${field.label}`} className="va-screen__row">
              <dt>{field.label}</dt>
              <dd>
                {field.before !== undefined ? (
                  <>
                    <span className="sr-only">{t("assistant.screen.before", lang)} </span>
                    <span className="va-screen__before">{field.before}</span>
                    <span className="va-screen__arrow" aria-hidden="true">
                      {" → "}
                    </span>
                    <span className="sr-only">, {t("assistant.screen.after", lang)} </span>
                  </>
                ) : null}
                <strong>{field.after}</strong>
              </dd>
            </div>
          ))}
        </dl>

        {confirmation.spendWarning ? (
          <p className="va-screen__warning">
            <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>
              <strong>{t("assistant.screen.warningPrefix", lang)}</strong> {confirmation.spendWarning}
            </span>
          </p>
        ) : null}
        {notes.map((note, i) => (
          <p key={`${i}-${note}`} className="va-screen__note">
            {note}
          </p>
        ))}

        <p className="va-screen__hint">{t("assistant.screen.voiceHint", lang)}</p>
        <p className="va-screen__expires">
          {busy ? t("assistant.pending.applying", lang) : t("assistant.screen.expires", lang).replace("{seconds}", String(remaining))}
        </p>
        <div className="va-screen__bar" aria-hidden="true">
          <span style={{ width: `${busy ? 100 : pct}%` }} />
        </div>
        <p id={armingId} className="sr-only">
          {t("assistant.screen.arming", lang)}
        </p>
        {/* Pencere açıkken sayfanın canlı bölgeleri inert: eşik duyuruları burada. */}
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement ? <span key={announcement.seq}>{announcement.text}</span> : null}
        </p>
      </div>
    </Dialog>
  );
}
