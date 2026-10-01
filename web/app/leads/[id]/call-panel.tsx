"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { api } from "../../_lib/client-api";
import { Badge, type Tone } from "../../_components/ui";
import { ConfirmDialog, Dialog } from "../../_components/dialog";
import { formatDate } from "../../_lib/format";
import { CALL_CONSENT_TEXT, CONSENT_EVIDENCE_BASES, todayInIstanbul } from "../../_lib/consent-texts";

interface CallRow {
  id: string;
  status: string;
  trigger: string;
  outcome: string | null;
  summary: string | null;
  durationSecs: number | null;
  failureReason: string | null;
  startedAt: string | null;
  createdAt: string;
}

interface CallState {
  canCall: boolean;
  mock: boolean;
  configured: boolean;
  consent: boolean;
  attempts: number;
  blockers: { code: string; label: string }[];
  calls: CallRow[];
}

const CALL_STATUS: Record<string, { label: string; tone: Tone }> = {
  QUEUED: { label: "Sırada", tone: "blue" },
  INITIATED: { label: "Aranıyor", tone: "blue" },
  COMPLETED: { label: "Görüşüldü", tone: "green" },
  NO_ANSWER: { label: "Yanıt yok", tone: "amber" },
  BUSY: { label: "Meşgul", tone: "amber" },
  VOICEMAIL: { label: "Sesli mesaja düştü", tone: "amber" },
  FAILED: { label: "Başlatılamadı", tone: "red" },
};

function duration(secs: number | null): string | null {
  if (!secs) return null;
  const minutes = Math.floor(secs / 60);
  return minutes > 0 ? `${minutes} dk ${secs % 60} sn` : `${secs} sn`;
}

/**
 * Sesli ajan araması (ADR-0026): telefonla aranma rızası, müsaitlik durumu, "Ajan arasın" düğmesi ve arama
 * geçmişi. Kurallar sunucuda denetlenir; burada yalnızca sonucu gösterilir.
 */
export function CallPanel({ leadId, onConsentChanged }: { leadId: string; onConsentChanged: () => void }) {
  const [state, setState] = useState<CallState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmCall, setConfirmCall] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [basis, setBasis] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState("");
  const legendId = useId();

  const load = useCallback(async () => {
    try {
      setState(await api<CallState>(`/api/leads/${leadId}/calls`));
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Arama bilgisi yüklenemedi.");
    }
  }, [leadId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function startCall() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/leads/${leadId}/calls`, "POST", {});
      setConfirmCall(false);
      setNotice(state?.mock ? "Deneme modu: arama kaydı oluşturuldu, gerçek arama yapılmadı." : "Arama başlatıldı. Sonuç geldiğinde burada görünür.");
    } catch (e) {
      setConfirmCall(false);
      setError(e instanceof Error ? e.message : "Arama başlatılamadı. Tekrar deneyin.");
    } finally {
      setBusy(false);
      void load();
    }
  }

  async function saveConsent() {
    if (!basis) return setFormError("Rızanın nasıl alındığını seçin.");
    if (!date) return setFormError("Rızanın alındığı tarihi girin.");
    if (date > todayInIstanbul()) return setFormError("Rızanın alındığı tarih ileri bir tarih olamaz.");
    setBusy(true);
    setFormError("");
    try {
      await api(`/api/leads/${leadId}/call-consent`, "PUT", {
        granted: true,
        evidence: { basis, obtainedAt: date, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      setConsentOpen(false);
      setNotice("Telefonla aranma rızası kaydedildi.");
      onConsentChanged();
      void load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Rıza kaydedilemedi. Tekrar deneyin.");
    } finally {
      setBusy(false);
    }
  }

  async function withdrawConsent() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/leads/${leadId}/call-consent`, "PUT", { granted: false });
      setNotice("Telefonla aranma rızası geri çekildi olarak kaydedildi.");
      onConsentChanged();
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kaydedilemedi. Tekrar deneyin.");
    } finally {
      setWithdrawOpen(false);
      setBusy(false);
    }
  }

  return (
    <section className="border-b border-line-soft px-4 py-4" aria-labelledby="arama-baslik">
      <h2 id="arama-baslik" className="text-base font-semibold text-ink">
        Sesli asistan araması
      </h2>
      <p className="mt-2 text-sm text-muted">
        Yapay zekâ destekli sesli asistan, lead&apos;i yalnızca telefonla aranma rızası kayıtlıysa ve lead&apos;in yerel
        saatiyle arama saatleri içinde arar. Arama başında yapay zekâ olduğunu ve görüşmenin kaydedildiğini söyler.
      </p>
      {loadError ? (
        <p role="alert" className="mt-3 text-sm text-rose-700">
          {loadError}
        </p>
      ) : !state ? (
        <p className="mt-3 text-sm text-muted">Yükleniyor…</p>
      ) : (
        <div className="mt-3 space-y-3">
          {state.mock ? (
            <p className="text-sm text-ink-2">Deneme modu açık: düğme arama kaydı oluşturur, gerçek arama yapılmaz.</p>
          ) : !state.configured ? (
            <p className="text-sm text-ink-2">
              Sesli arama sunucuda yapılandırılmamış. Kurulum adımları: <code>docs/runbook.md</code> &ldquo;Sesli arama&rdquo;.
            </p>
          ) : null}
          <p className="text-sm text-ink-2">
            {state.consent ? "Telefonla aranma rızası kayıtlı." : "Telefonla aranma rızası kayıtlı değil."}
          </p>
          {state.blockers.length > 0 && (
            <div className="text-sm text-ink-2">
              <p className="font-medium text-ink">Şu an aranamaz:</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {state.blockers.map((b) => (
                  <li key={b.code}>{b.label}</li>
                ))}
              </ul>
            </div>
          )}
          {state.canCall && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="primary-button"
                disabled={busy || state.blockers.length > 0 || (!state.mock && !state.configured)}
                onClick={() => setConfirmCall(true)}
              >
                Ajan arasın
              </button>
              {state.consent ? (
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setWithdrawOpen(true)}>
                  Arama rızası geri çekildi
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setBasis("");
                    setDate(todayInIstanbul());
                    setNote("");
                    setFormError("");
                    setConsentOpen(true);
                  }}
                >
                  Arama rızasını kaydet
                </button>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              {error}
            </p>
          )}
          <p role="status" className={notice ? "text-sm text-emerald-800" : "sr-only"}>
            {notice}
          </p>
          {state.calls.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-ink">Arama geçmişi</h3>
              <ul className="space-y-2">
                {state.calls.map((call) => {
                  const status = CALL_STATUS[call.status] ?? { label: call.status, tone: "gray" as Tone };
                  const length = duration(call.durationSecs);
                  return (
                    <li key={call.id} className="rounded-lg border border-line p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={status.tone}>{status.label}</Badge>
                        <span className="text-xs text-muted">
                          {call.trigger === "AUTO" ? "Otomatik" : "Elle başlatıldı"}
                          {" · "}
                          <time dateTime={call.startedAt ?? call.createdAt}>{formatDate(call.startedAt ?? call.createdAt)}</time>
                          {length ? ` · ${length}` : ""}
                        </span>
                      </div>
                      {call.summary && <p className="mt-1 whitespace-pre-line text-sm text-ink-2">{call.summary}</p>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmCall}
        title="Sesli asistan bu lead'i arasın mı?"
        description="Arama hemen başlar. Asistan, klinik adına aradığını, yapay zekâ olduğunu ve görüşmenin kaydedildiğini söyler."
        confirmLabel="Aramayı başlat"
        busy={busy}
        busyLabel="Başlatılıyor…"
        onConfirm={() => void startCall()}
        onCancel={() => setConfirmCall(false)}
      />

      <ConfirmDialog
        open={withdrawOpen}
        title="Arama rızası geri çekildi olarak kaydedilsin mi?"
        description="Hastanın telefonla aranma rızasını geri çektiğini kaydedersiniz. Sesli asistan bu lead'i artık aramaz."
        confirmLabel="Geri çekildi olarak kaydet"
        tone="danger"
        busy={busy}
        busyLabel="Kaydediliyor…"
        onConfirm={() => void withdrawConsent()}
        onCancel={() => setWithdrawOpen(false)}
      />

      <Dialog
        open={consentOpen}
        title="Telefonla aranma rızasını kaydet"
        description="Rızayı hasta verir; siz yalnızca verdiği rızayı kayda geçirirsiniz. Kaydetmeden önce hastanın aşağıdaki metne açıkça onay verdiğinden emin olun."
        onClose={() => {
          if (!busy) setConsentOpen(false);
        }}
        footer={
          <>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setConsentOpen(false)}>
              Vazgeç
            </button>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void saveConsent()}>
              {busy ? "Kaydediliyor…" : "Rızayı kaydet"}
            </button>
          </>
        }
      >
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-semibold text-muted">Kaydedilecek rıza metni</p>
          <p className="mt-1 text-sm text-slate-900">{CALL_CONSENT_TEXT}</p>
        </div>
        <fieldset aria-labelledby={legendId} className="space-y-2">
          <legend id={legendId} className="text-sm font-medium text-slate-900">
            Rıza nasıl alındı?
          </legend>
          {CONSENT_EVIDENCE_BASES.map((b) => (
            <label key={b.value} className="flex min-h-9 items-center gap-2 text-sm text-slate-800">
              <input type="radio" name="call-consent-basis" value={b.value} checked={basis === b.value} onChange={() => setBasis(b.value)} />
              {b.label}
            </label>
          ))}
        </fieldset>
        <label className="field">
          Rızanın alındığı tarih
          <input type="date" value={date} max={todayInIstanbul()} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          Not (isteğe bağlı)
          <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {formError && (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {formError}
          </p>
        )}
      </Dialog>
    </section>
  );
}
