"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Erişilebilir diyalog (ADR-0016 · Faz 1): tarayıcının `<dialog>` + `showModal()` davranışı odağı
 * diyalogda tutar, arka planı devre dışı bırakır ve Esc ile kapatır; kapanınca odak açan öğeye döner.
 * Açık/kapalı durumu React state'i yönetir (`open`); Esc ve arka plan `onClose` çağırır.
 * `window.confirm` / `window.prompt` yerine bu bileşen kullanılır.
 */
export function Dialog({
  open,
  title,
  description,
  children,
  footer,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="app-dialog"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(e) => {
        // Esc: kapanışı React state'i yönetsin.
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Arka plana (diyalog kutusunun dışına) tıklama kapatır.
        if (e.target === e.currentTarget) {
          const box = e.currentTarget.getBoundingClientRect();
          const inside =
            e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
          if (!inside) onClose();
        }
      }}
    >
      {open ? (
        <div className="space-y-4">
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">
            {title}
          </h2>
          {description ? (
            <div id={descriptionId} className="text-sm leading-6 text-slate-700">
              {description}
            </div>
          ) : null}
          {children}
          {footer ? <div className="flex flex-wrap justify-end gap-3 pt-2">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * Onay diyaloğu: harcama başlatan ya da geri alınamayan eylemler için.
 * Hata diyaloğun içinde gösterilir (sayfa silinmez); `busy` iken düğmeler kilitlenir.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Vazgeç",
  tone = "primary",
  busy = false,
  busyLabel = "İşleniyor…",
  confirmDisabled = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  busyLabel?: string;
  confirmDisabled?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        <>
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel} autoFocus>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === "danger" ? "danger-button" : "primary-button"}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      }
    >
      {children}
      {error ? (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
