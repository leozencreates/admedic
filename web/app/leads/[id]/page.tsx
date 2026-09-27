"use client";
import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "../../_lib/client-api";
import { LeadChat } from "../../_components/lead-chat";
import { Badge } from "../../_components/ui";
import { toLead, type ApiLead } from "../../_components/lead-table";
import { formatDate } from "../../_lib/format";
import { LanguageSwitcher } from "../../_components/language-switcher";
import type { Tone } from "../../_components/ui";

const STATUS_TONE: Record<string, Tone> = {
  NEW: "blue",
  CONTACTED: "amber",
  QUALIFIED: "green",
  CONSULTATION_BOOKED: "violet",
  TRAVEL_PLANNED: "blue",
  TREATED: "green",
  LOST: "red",
};

const STATUS_LABEL: Record<string, string> = {
  NEW: "Yeni",
  CONTACTED: "İletişime Geçildi",
  QUALIFIED: "Değerlendirildi",
  CONSULTATION_BOOKED: "Danışma Randevusu",
  TRAVEL_PLANNED: "Seyahat Planlandı",
  TREATED: "Tedavi Edildi",
  LOST: "Kaybedildi",
};

interface ConsentRow {
  id: string;
  type: string;
  status: string;
  source: string | null;
  consentText: string;
  acceptedAt: string | null;
  withdrawnAt: string | null;
  createdAt: string;
  basis: string | null;
  formLanguage: string | null;
}

interface LeadExtras {
  lostReason?: string | null;
  pendingFetch?: { error: string | null; attempts: number } | null;
  consents?: ConsentRow[];
}

const CONSENT_TYPE_LABEL: Record<string, string> = {
  MARKETING: "Pazarlama iletişimi",
  DATA_PROCESSING: "Veri işleme ve iletişim",
  HEALTH_QUESTIONNAIRE: "Sağlık formu",
};
const CONSENT_STATUS_LABEL: Record<string, string> = {
  GRANTED: "Verildi",
  DENIED: "Verilmedi",
  WITHDRAWN: "Geri çekildi",
  PENDING: "Bekliyor",
};
const CONSENT_SOURCE_LABEL: Record<string, string> = {
  INSTANT_FORM: "Meta Instant Form",
  PANEL: "Panel",
  API: "API",
};
const CONSENT_BASIS_LABEL: Record<string, string> = {
  CHECKBOX_RESPONSE: "formdaki kutu işaretli (Meta yanıtı)",
  REQUIRED_CHECKBOX: "zorunlu kutu (form ancak işaretlenerek gönderilebilir)",
};

const FLOW: Record<string, string[]> = {
  NEW: ["CONTACTED", "LOST"],
  CONTACTED: ["QUALIFIED", "LOST"],
  QUALIFIED: ["CONSULTATION_BOOKED", "LOST"],
  CONSULTATION_BOOKED: ["TRAVEL_PLANNED", "LOST"],
  TRAVEL_PLANNED: ["TREATED", "LOST"],
};

export default function LeadDetailPage() {
  const { id } = useParams();
  const [lead, setLead] = useState<(ReturnType<typeof toLead> & LeadExtras) | null>(null);
  const [refetching, setRefetching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentGiven, setConsentGiven] = useState(false);
  const [showLostDialog, setShowLostDialog] = useState(false);
  const [lostReasonInput, setLostReasonInput] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ lead: ApiLead & LeadExtras }>(`/api/leads/${id}`);
      setLead({
        ...toLead(data.lead),
        lostReason: data.lead.lostReason ?? null,
        pendingFetch: data.lead.pendingFetch ?? null,
        consents: data.lead.consents ?? [],
      });
      setConsentGiven(data.lead.consentGiven ?? false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lead yüklenemedi.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [id]);

  async function transitionStatus(nextStatus: string, reason?: string) {
    if (nextStatus === "LOST" && !reason) {
      setShowLostDialog(true);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload: { status: string; lostReason?: string } = { status: nextStatus };
      if (nextStatus === "LOST") {
        payload.lostReason = reason?.trim();
      }
      await api(`/api/leads/${id}`, "PATCH", payload);
      setLead((prev) => (prev ? { ...prev, status: nextStatus, lostReason: reason?.trim() ?? prev.lostReason } : prev));
      setShowLostDialog(false);
      setLostReasonInput("");
      setNotice(`Durum güncellendi: ${STATUS_LABEL[nextStatus] ?? nextStatus}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Durum güncellenemedi.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmLost() {
    if (!lostReasonInput.trim()) {
      setError("Lütfen kayıp nedenini belirtin.");
      return;
    }
    await transitionStatus("LOST", lostReasonInput);
  }

  async function refetchFromMeta() {
    setRefetching(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ recovered: number; failed: number; results: { status: string; message?: string }[] }>(
        "/api/leads/refetch",
        "POST",
        { leadId: id },
      );
      if (result.recovered > 0) {
        setNotice("Lead alanları Meta'dan çekildi.");
        await load();
      } else {
        setError(result.results[0]?.message ?? "Lead alanları hâlâ çekilemiyor; Meta bağlantısını ve lead izinlerini kontrol edin.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Yeniden çekme başarısız.");
    } finally {
      setRefetching(false);
    }
  }

  async function grantConsent() {
    setConsentBusy(true);
    try {
      await api(`/api/leads/${id}`, "PATCH", { consentGiven: true });
      setConsentGiven(true);
      setNotice("Rıza kaydı oluşturuldu.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rıza kaydedilemedi.");
    } finally {
      setConsentBusy(false);
    }
  }

  async function withdrawConsent() {
    if (!window.confirm("Rıza geri çekilsin mi? Lead pazarlama iletişimine kapatılır ve rıza kayıtları geri çekildi olarak işaretlenir.")) return;
    setConsentBusy(true);
    try {
      await api(`/api/leads/${id}`, "PATCH", { consentGiven: false });
      setConsentGiven(false);
      setNotice("Rıza geri çekildi.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rıza geri çekilemedi.");
    } finally {
      setConsentBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="studio-card animate-pulse" role="status">
        Lead detayı yükleniyor…
      </div>
    );
  }

  if (error || !lead) {
    return (
      <div className="space-y-4">
        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
            {error}
          </div>
        )}
        <Link href="/leads" className="text-sm text-violet-600">
          ← Lead listesine geri dön
        </Link>
      </div>
    );
  }

  const nextStatuses = FLOW[lead.status] ?? [];

  return (
    <div className="space-y-6">
      <Link href="/leads" className="text-sm text-violet-600">
        ← Lead listesine geri dön
      </Link>

      <header className="studio-hero">
        <span className="eyebrow">LEAD DETAY</span>
        <h1>{lead.name}</h1>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Badge tone={STATUS_TONE[lead.status] ?? "gray"}>
            {STATUS_LABEL[lead.status] ?? lead.status}
          </Badge>
          <span className="text-xs text-slate-400">
            Oluşturulma: {formatDate(lead.created)}
          </span>
          <LanguageSwitcher />
        </div>
      </header>

      {lead.pendingFetch && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" role="status">
          <p className="font-semibold">Form yanıtları Meta'dan çekilemedi</p>
          <p className="mt-1">
            Lead kimliğiyle kaydedildi; ad, iletişim ve form yanıtları eksik.
            {lead.pendingFetch.error ? ` Son hata: ${lead.pendingFetch.error}` : ""}
            {` (deneme: ${lead.pendingFetch.attempts})`}
          </p>
          <p className="mt-1 text-xs">
            Meta bağlantısı yenilendiğinde ve yeni lead geldiğinde otomatik yeniden denenir.
          </p>
          <button className="primary-button mt-3" disabled={refetching} onClick={() => void refetchFromMeta()}>
            {refetching ? "Çekiliyor…" : "Meta'dan yeniden çek"}
          </button>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section className="studio-card">
          <div className="section-kicker">BİLGİLER</div>
          <h2>Kişi Bilgileri</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Ad</dt>
              <dd className="font-medium text-slate-900">{lead.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Telefon</dt>
              <dd className="font-medium text-slate-900">{lead.phone}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">E-posta</dt>
              <dd className="font-medium text-slate-900">{lead.email}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Kanal</dt>
              <dd className="font-medium text-slate-900">{lead.channel || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Ülke</dt>
              <dd className="font-medium text-slate-900">{lead.country || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Dil</dt>
              <dd className="font-medium text-slate-900">{lead.language || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">İlgilenilen hizmet</dt>
              <dd className="font-medium text-slate-900">{lead.interestedService || "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Kaynak kampanya</dt>
              <dd className="font-mono text-xs text-slate-900 text-right">
                {lead.campaignId || lead.adSetId || lead.adId ? (
                  <>
                    <span>Kampanya: {lead.campaignId || "—"}</span>
                    <br />
                    <span>Reklam seti: {lead.adSetId || "—"}</span>
                    <br />
                    <span>Reklam: {lead.adId || "—"}</span>
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Durum</dt>
              <dd>
                <Badge tone={STATUS_TONE[lead.status] ?? "gray"}>
                  {STATUS_LABEL[lead.status] ?? lead.status}
                </Badge>
              </dd>
            </div>
            {lead.status === "LOST" && lead.lostReason && (
              <div className="flex justify-between rounded-lg bg-rose-50 p-2 text-rose-800">
                <dt className="text-rose-600 font-medium">Kayıp Nedeni</dt>
                <dd className="font-semibold text-right">{lead.lostReason}</dd>
              </div>
            )}
          </dl>
        </section>

        <section className="studio-card">
          <div className="section-kicker">DURUM GEÇİŞİ</div>
          <h2>Durum Atlama</h2>
          <p className="mt-2 text-sm text-slate-500">
            Bu lead'in şu anki durumu:{" "}
            <strong>{STATUS_LABEL[lead.status] ?? lead.status}</strong>
          </p>
          {nextStatuses.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-3">
              {nextStatuses.map((next) => (
                <button
                  key={next}
                  className={next === "LOST" ? "rounded-xl border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100" : "primary-button"}
                  disabled={busy}
                  onClick={() => transitionStatus(next)}
                >
                  {busy ? "Güncelleniyor…" : `${STATUS_LABEL[next] ?? next} →`}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-400">
              Bu durumdan ileri geçiş yapılamıyor veya lead zaten son duruma erişmiş.
            </p>
          )}
        </section>
      </div>

      {showLostDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4">
            <h3 className="text-lg font-semibold text-slate-900">Lead Kaybı Nedeni</h3>
            <p className="text-sm text-slate-600">
              Bu lead'i <strong>Kaybedildi (LOST)</strong> olarak işaretlemek için lütfen bir neden belirtin (fiyat yüksek, başka klinik seçti, iletişim koptu, vb.).
            </p>
            <textarea
              className="w-full rounded-xl border border-slate-300 p-3 text-sm focus:border-violet-500 focus:outline-none"
              rows={3}
              placeholder="Örn: Bütçe yetersiz, yerel tedaviyi seçti…"
              value={lostReasonInput}
              onChange={(e) => setLostReasonInput(e.target.value)}
            />
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setShowLostDialog(false);
                  setLostReasonInput("");
                }}
              >
                İptal
              </button>
              <button
                type="button"
                className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
                disabled={busy}
                onClick={confirmLost}
              >
                {busy ? "Kaydediliyor…" : "Kaybı Onayla"}
              </button>
            </div>
          </div>
        </div>
      )}

      {notice && (
        <p role="status" className="text-sm text-violet-700">
          {notice}
        </p>
      )}

      <section className="studio-card">
        <div className="section-kicker">RIZA KAYDI</div>
        <h2>Rıza ve Onaylar</h2>
        {consentGiven ? (
          <div className="mt-3 space-y-3">
            <div className="flex items-center gap-2 text-sm text-green-700">
              <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
              Pazarlama iletişimi ve Meta dönüşüm ölçümü (CAPI) onaylandı.
            </div>
            <button
              className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
              disabled={consentBusy}
              onClick={() => void withdrawConsent()}
            >
              {consentBusy ? "Kaydediliyor…" : "Rızayı Geri Çek"}
            </button>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-slate-500">
              Pazarlama iletişimi ve Meta dönüşüm ölçümü (CAPI) için ayrı onay gerekir. Instant Form rıza kutusu
              yalnızca talebe yanıt ve iletişim için veri işleme onayıdır.
            </p>
            <button
              className="primary-button"
              disabled={consentBusy}
              onClick={() => void grantConsent()}
            >
              {consentBusy ? "Kaydediliyor…" : "Rıza Ver"}
            </button>
          </div>
        )}
        {(lead.consents ?? []).length > 0 && (
          <div className="mt-5 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rıza kayıtları</p>
            <ul className="space-y-2">
              {(lead.consents ?? []).map((c) => (
                <li key={c.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={c.status === "GRANTED" ? "green" : c.status === "WITHDRAWN" || c.status === "DENIED" ? "red" : "gray"}>
                      {CONSENT_STATUS_LABEL[c.status] ?? c.status}
                    </Badge>
                    <span className="font-medium text-slate-900">{CONSENT_TYPE_LABEL[c.type] ?? c.type}</span>
                    <span className="text-xs text-slate-500">
                      {CONSENT_SOURCE_LABEL[c.source ?? ""] ?? "Kaynak belirtilmemiş"}
                      {c.formLanguage ? ` · form dili ${c.formLanguage}` : ""}
                      {" · "}
                      {formatDate(c.acceptedAt ?? c.createdAt)}
                    </span>
                  </div>
                  {c.basis && (
                    <p className="mt-1 text-xs text-slate-500">Dayanak: {CONSENT_BASIS_LABEL[c.basis] ?? c.basis}</p>
                  )}
                  {c.withdrawnAt && <p className="mt-1 text-xs text-rose-600">Geri çekilme: {formatDate(c.withdrawnAt)}</p>}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-violet-600">Onaylanan metin</summary>
                    <p className="mt-1 whitespace-pre-line text-xs text-slate-600">{c.consentText}</p>
                  </details>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <LeadChat leadId={lead.id} leadChannel={lead.channel} />
    </div>
  );
}
