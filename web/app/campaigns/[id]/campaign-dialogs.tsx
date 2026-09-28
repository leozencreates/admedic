"use client";
import { useId } from "react";
import { ConfirmDialog, Dialog } from "../../_components/dialog";
import {
  MONTH_DAYS,
  REJECT_REASON_MAX,
  REJECT_REASON_MIN,
  dailyBudgetCents,
  money,
  type CampaignData,
  type OrgSettings,
} from "../../_lib/campaign-ui";
import { formatNumber } from "../../_lib/format";

export interface ConfirmState { busy: boolean; error: string }
export interface RejectState { reason: string; fieldError: string; error: string; busy: boolean }

/** Etkinleştirme onayının gövdesi: harcanacak para, aylık etki ve Meta reddi uyarısı (hepsi `aria-describedby`). */
function ActivationSummary({ campaign: c, settings }: { campaign: CampaignData; settings: OrgSettings | null }) {
  const daily = dailyBudgetCents(c);
  const monthly = daily != null ? daily * MONTH_DAYS : null;
  const sameCurrency = settings != null && settings.currency === (c.currency ?? "EUR");
  // Kampanya Meta'da zaten etkin sayılıyorsa (rezervasyon) toplamda iki kez sayılmasın (sunucu da hariç tutar).
  const others =
    settings && sameCurrency
      ? Math.max(0, settings.monthlyCommittedCents - (c.status === "ACTIVE" && monthly != null ? monthly : 0))
      : null;
  const total = others != null && monthly != null ? others + monthly : null;
  const cap = settings && sameCurrency ? settings.monthlyAdBudgetCapCents : null;
  const exceeds = total != null && cap != null && total > cap;
  const disapproved = c.review?.disapproved ?? 0;
  return (
    <div className="space-y-3">
      <p>
        {daily != null ? (
          <>
            <span className="font-semibold text-ink">{c.name}</span> için günlük{" "}
            <span className="font-semibold text-ink">{money(daily, c.currency)}</span> harcama başlayacak.
          </>
        ) : (
          <>
            <span className="font-semibold text-ink">{c.name}</span> etkinleştirilince harcama, Meta&apos;daki bütçe ayarına göre başlayacak.
          </>
        )}
      </p>
      {monthly != null && (
        <ul className="list-inside list-disc space-y-1">
          <li>Bu kampanyanın aylık tahmini {money(monthly, c.currency)} (günlük bütçe × {MONTH_DAYS}).</li>
          {total != null &&
            (cap != null ? (
              <li>
                Etkin kampanyalarla birlikte aylık tahmini {money(total, c.currency)} / üst sınır {money(cap, c.currency)}.
              </li>
            ) : (
              <li>Etkin kampanyalarla birlikte aylık tahmini {money(total, c.currency)}; aylık üst sınır tanımlı değil.</li>
            ))}
        </ul>
      )}
      {exceeds && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800">
          Bu toplam aylık üst sınırı aşıyor; etkinleştirme engellenecek. Önce üst sınırı yükseltin ya da etkin bir kampanyayı duraklatın.
        </p>
      )}
      {disapproved > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
          Meta {formatNumber(disapproved)} reklamı reddetti; reddedilen reklamlar yayınlanmaz. Önce düzeltmeniz önerilir.
        </p>
      )}
    </div>
  );
}

export function ActivationDialog({
  campaign,
  settings,
  state,
  onConfirm,
  onCancel,
}: {
  campaign: CampaignData;
  settings: OrgSettings | null;
  state: ConfirmState | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={state != null}
      title="Kampanya etkinleştirilsin mi?"
      description={state ? <ActivationSummary campaign={campaign} settings={settings} /> : undefined}
      confirmLabel="Kampanyayı etkinleştir"
      cancelLabel="Vazgeç"
      busy={state?.busy}
      busyLabel="Etkinleştiriliyor…"
      error={state?.error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export function ArchiveDialog({
  campaign,
  state,
  onConfirm,
  onCancel,
}: {
  campaign: CampaignData;
  state: ConfirmState | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={state != null}
      title="Kampanya arşivlensin mi?"
      description={
        state ? (
          <p>
            <span className="font-semibold text-ink">{campaign.name}</span> Meta&apos;da duraklatılır ve arşive taşınır
            {campaign.workflowStatus === "ACTIVE" ? "; harcama hemen durur" : ""}. Arşivdeki kampanya bu ekrandan yeniden
            etkinleştirilemez.
          </p>
        ) : undefined
      }
      confirmLabel="Kampanyayı arşivle"
      cancelLabel="Vazgeç"
      tone="danger"
      busy={state?.busy}
      busyLabel="Arşivleniyor…"
      error={state?.error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/** Düzeltme isteği: gerekçe zorunlu (sunucudaki `reject` ucunun sınırlarıyla aynı). */
export function RejectDialog({
  campaign,
  state,
  fieldId,
  onChange,
  onConfirm,
  onCancel,
}: {
  campaign: CampaignData;
  state: RejectState | null;
  /** Gerekçe alanının kimliği (doğrulama hatasında odak buraya taşınır). */
  fieldId: string;
  onChange: (reason: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const hintId = useId();
  const errorId = useId();
  const length = state?.reason.length ?? 0;
  return (
    <Dialog
      open={state != null}
      title="Kampanyada düzeltme iste"
      description={
        state ? (
          <p>
            <span className="font-semibold text-ink">{campaign.name}</span> onaydan geri çevrilir. Gerekçeniz kampanya
            sayfasında gösterilir; kampanya düzeltildikten sonra yeniden onaya gönderilebilir.
          </p>
        ) : undefined
      }
      onClose={() => {
        if (!state?.busy) onCancel();
      }}
      footer={
        <>
          <button type="button" className="secondary-button" disabled={state?.busy} onClick={onCancel}>
            Vazgeç
          </button>
          <button type="button" className="primary-button" disabled={state?.busy} onClick={onConfirm}>
            {state?.busy ? "Kaydediliyor…" : "Düzeltme iste"}
          </button>
        </>
      }
    >
      <div className="space-y-1.5">
        <label className="field" htmlFor={fieldId}>
          Düzeltme gerekçesi
          <textarea
            id={fieldId}
            rows={4}
            required
            minLength={REJECT_REASON_MIN}
            maxLength={REJECT_REASON_MAX}
            value={state?.reason ?? ""}
            aria-invalid={state?.fieldError ? true : undefined}
            aria-describedby={state?.fieldError ? `${errorId} ${hintId}` : hintId}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        {state?.fieldError ? (
          <p id={errorId} role="alert" className="text-xs font-medium text-rose-700">
            {state.fieldError}
          </p>
        ) : null}
        <p id={hintId} className="text-xs text-muted">
          En az {REJECT_REASON_MIN}, en fazla {REJECT_REASON_MAX} karakter ({length}/{REJECT_REASON_MAX}).
        </p>
        {state?.error ? (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {state.error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
