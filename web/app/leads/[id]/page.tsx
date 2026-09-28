"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { api } from "../../_lib/client-api";
import { LeadChat } from "../../_components/lead-chat";
import { Badge } from "../../_components/ui";
import { StageBar } from "../../_components/stage-bar";
import { leadStage } from "../../_lib/stages";
import { ConfirmDialog, Dialog } from "../../_components/dialog";
import { toLead, type ApiLead } from "../../_components/lead-table";
import { formatDate } from "../../_lib/format";
import {
  LOST_REASONS,
  channelLabel,
  consentBasisLabel,
  consentSourceLabel,
  consentStatusStyle,
  consentTypeLabel,
  countryName,
  languageName,
  leadStatusStyle,
  leadTransitionLabel,
} from "../../_lib/labels";
import {
  CONSENT_EVIDENCE_BASES,
  DEFAULT_MARKETING_CONSENT_TEXT,
  todayInIstanbul,
} from "../../_lib/consent-texts";

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
  evidenceNote?: string | null;
}

interface SourceRef {
  id: string;
  name: string;
}

interface LeadExtras {
  lostReason?: string | null;
  pendingFetch?: { error: string | null; attempts: number } | null;
  consents?: ConsentRow[];
  /** Kaynak kampanya/reklam seti/reklamın paneldeki adı (GET /api/leads/:id). */
  source?: { campaign: SourceRef | null; adSet: SourceRef | null; ad: SourceRef | null } | null;
}

/** Sunucudaki geçiş kuralıyla aynı (api/leads/[id]/route.ts VALID_TRANSITIONS). */
const FLOW: Record<string, string[]> = {
  NEW: ["CONTACTED", "LOST"],
  CONTACTED: ["QUALIFIED", "LOST"],
  QUALIFIED: ["CONSULTATION_BOOKED", "LOST"],
  CONSULTATION_BOOKED: ["TRAVEL_PLANNED", "LOST"],
  TRAVEL_PLANNED: ["TREATED", "LOST"],
};

const OTHER_REASON = "Diğer";
const LOST_CHOICES: string[] = [...LOST_REASONS, OTHER_REASON];
/** Kayıp nedeni sunucuda en fazla 1000 karakter; hazır neden ve ayraç için pay bırakılır. */
const LOST_NOTE_MAX = 900;

/** Gönderilen kayıp nedeni: hazır neden, "Diğer: not" ya da "neden — not". */
function composeLostReason(choice: string, note: string): string {
  if (choice === OTHER_REASON) return `${OTHER_REASON}: ${note}`;
  return note ? `${choice} — ${note}` : choice;
}

/**
 * Telefon bağlantıları. Maskeli ("+90***04") ya da okunamayan numara bağlantı olmaz. Uluslararası
 * biçim (+, 00 ya da ülke koduyla başlayan WhatsApp numarası) `tel:+…` ve wa.me alır; "0" ile başlayan
 * yerel numara yalnızca Türkiye lead'inde +90'a çevrilir, başka ülkede yalnızca olduğu gibi aranır.
 */
function phoneLinks(phone: string, country: string): { tel: string; whatsapp: string | null } | null {
  if (!phone || !/^[\d\s+().-]+$/.test(phone)) return null;
  const raw = phone.replace(/[^\d+]/g, "");
  let digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return null;
  let international = raw.startsWith("+") || !digits.startsWith("0") || digits.startsWith("00");
  if (!raw.startsWith("+") && digits.startsWith("00")) digits = digits.slice(2);
  else if (!raw.startsWith("+") && digits.startsWith("0") && country.toUpperCase() === "TR") {
    digits = `90${digits.slice(1)}`;
    international = true;
  }
  return international
    ? { tel: `tel:+${digits}`, whatsapp: `https://wa.me/${digits}` }
    : { tel: `tel:${raw}`, whatsapp: null };
}

/** Dar kaptaki sekme: sohbet ya da lead bilgileri (geniş kapta ikisi birden görünür). */
type DetailTab = "chat" | "info";

type LostErrors = { reason?: string; note?: string; submit?: string };

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [lead, setLead] = useState<(ReturnType<typeof toLead> & LeadExtras) | null>(null);
  const [loading, setLoading] = useState(true);
  /** Sayfa yüklenemediyse (sayfa düzeyi); işlem hataları sayfayı asla silmez. */
  const [loadError, setLoadError] = useState("");
  const [refetching, setRefetching] = useState(false);
  const [refetchError, setRefetchError] = useState("");
  const [refetchNotice, setRefetchNotice] = useState("");
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const [statusError, setStatusError] = useState("");
  const [statusNotice, setStatusNotice] = useState("");
  const [lostOpen, setLostOpen] = useState(false);
  const [lostChoice, setLostChoice] = useState("");
  const [lostNote, setLostNote] = useState("");
  const [lostErrors, setLostErrors] = useState<LostErrors>({});
  /** Rıza işlemlerinin hata/bilgi metni (rıza bloğu kendi yerinde gösterir). */
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentGiven, setConsentGiven] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawError, setWithdrawError] = useState("");
  const [consentBasis, setConsentBasis] = useState("");
  const [consentDate, setConsentDate] = useState("");
  const [consentNote, setConsentNote] = useState("");
  const [consentErrors, setConsentErrors] = useState<{ basis?: string; date?: string; submit?: string }>({});
  /** Kaydedilecek rıza beyanı: kuruluşun açık rıza metni, yoksa varsayılan metin. */
  const [consentStatement, setConsentStatement] = useState<string | null>(null);
  const consentBasisLegendId = useId();
  const consentBasisErrorId = useId();
  const consentDateErrorId = useId();
  const statusHeadingRef = useRef<HTMLHeadingElement>(null);
  const firstReasonRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const focusStatusAfterDialog = useRef(false);
  const lostLegendId = useId();
  const reasonErrorId = useId();
  const noteErrorId = useId();
  const [tab, setTab] = useState<DetailTab>("chat");
  const chatTabRef = useRef<HTMLButtonElement>(null);
  const infoTabRef = useRef<HTMLButtonElement>(null);
  const chatTabId = useId();
  const infoTabId = useId();
  const chatPanelId = useId();
  const infoPanelId = useId();

  /** `initial`: ilk yükleme (hata sayfa düzeyinde); diğerleri sessiz yeniden yükleme. */
  const load = useCallback(
    async (options: { initial?: boolean } = {}) => {
      if (options.initial) {
        setLoading(true);
        setLoadError("");
      }
      try {
        const data = await api<{ lead: ApiLead & LeadExtras }>(`/api/leads/${id}`);
        setLead({
          ...toLead(data.lead),
          lostReason: data.lead.lostReason ?? null,
          pendingFetch: data.lead.pendingFetch ?? null,
          consents: data.lead.consents ?? [],
          source: data.lead.source ?? null,
        });
        setConsentGiven(data.lead.consentGiven ?? false);
      } catch (e) {
        if (options.initial)
          setLoadError(e instanceof Error ? e.message : "Lead yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.");
      } finally {
        if (options.initial) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    void load({ initial: true });
  }, [load]);

  // Kayıp diyaloğu başarıyla kapandığında odak "Durumu güncelle" başlığına gelir (açan düğme artık yok).
  useEffect(() => {
    if (!lostOpen && focusStatusAfterDialog.current) {
      focusStatusAfterDialog.current = false;
      statusHeadingRef.current?.focus();
    }
  }, [lostOpen]);

  /** Durumu kaydeder; hata metnini döner (başarıda null). */
  async function applyStatus(nextStatus: string, lostReason?: string): Promise<string | null> {
    setStatusBusy(nextStatus);
    setStatusError("");
    setStatusNotice("");
    try {
      await api(
        `/api/leads/${id}`,
        "PATCH",
        nextStatus === "LOST" ? { status: nextStatus, lostReason } : { status: nextStatus },
      );
      setLead((prev) =>
        prev
          ? { ...prev, status: nextStatus, lostReason: nextStatus === "LOST" ? (lostReason ?? null) : prev.lostReason }
          : prev,
      );
      setStatusNotice(`Durum güncellendi: ${leadStatusStyle(nextStatus).label}.`);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Durum güncellenemedi. Tekrar deneyin.";
    } finally {
      setStatusBusy(null);
    }
  }

  async function transitionStatus(nextStatus: string) {
    if (nextStatus === "LOST") {
      setLostChoice("");
      setLostNote("");
      setLostErrors({});
      setLostOpen(true);
      return;
    }
    const failure = await applyStatus(nextStatus);
    if (failure) setStatusError(failure);
  }

  function closeLostDialog() {
    if (statusBusy === "LOST") return;
    setLostOpen(false);
  }

  async function confirmLost() {
    const note = lostNote.trim();
    const errors: LostErrors = {};
    if (!lostChoice) errors.reason = "Bir kayıp nedeni seçin.";
    else if (lostChoice === OTHER_REASON && !note) errors.note = "“Diğer” için kısa bir açıklama yazın.";
    setLostErrors(errors);
    if (errors.reason) {
      firstReasonRef.current?.focus();
      return;
    }
    if (errors.note) {
      noteRef.current?.focus();
      return;
    }
    const failure = await applyStatus("LOST", composeLostReason(lostChoice, note));
    if (failure) {
      setLostErrors({ submit: failure });
      return;
    }
    focusStatusAfterDialog.current = true;
    setLostOpen(false);
  }

  async function refetchFromMeta() {
    setRefetching(true);
    setRefetchError("");
    setRefetchNotice("");
    try {
      const result = await api<{ recovered: number; failed: number; results: { status: string; message?: string }[] }>(
        "/api/leads/refetch",
        "POST",
        { leadId: id },
      );
      if (result.recovered > 0) {
        setRefetchNotice("Lead alanları Meta'dan çekildi.");
        await load();
      } else {
        setRefetchError(result.results[0]?.message ?? "Lead alanları hâlâ çekilemiyor; Meta bağlantısını ve lead izinlerini kontrol edin.");
      }
    } catch (e) {
      setRefetchError(e instanceof Error ? e.message : "Meta'dan yeniden çekilemedi. Birkaç dakika sonra tekrar deneyin.");
    } finally {
      setRefetching(false);
    }
  }

  async function openConsentDialog() {
    setConsentBasis("");
    setConsentDate(todayInIstanbul());
    setConsentNote("");
    setConsentErrors({});
    setError("");
    setNotice("");
    setConsentOpen(true);
    if (consentStatement === null) {
      try {
        const data = await api<{ settings: { consentText: string | null } }>("/api/org/settings");
        setConsentStatement(data.settings.consentText?.trim() || DEFAULT_MARKETING_CONSENT_TEXT);
      } catch {
        setConsentStatement(DEFAULT_MARKETING_CONSENT_TEXT);
      }
    }
  }

  /** Açık rıza kaydı: rızayı hasta verir; nasıl ve ne zaman alındığı kanıt olarak kaydedilir (ADR-0016). */
  async function recordConsent() {
    const errors: { basis?: string; date?: string } = {};
    if (!consentBasis) errors.basis = "Rızanın nasıl alındığını seçin.";
    if (!consentDate) errors.date = "Rızanın alındığı tarihi girin.";
    else if (consentDate > todayInIstanbul()) errors.date = "Rızanın alındığı tarih ileri bir tarih olamaz.";
    if (errors.basis || errors.date) {
      setConsentErrors(errors);
      return;
    }
    setConsentBusy(true);
    setConsentErrors({});
    try {
      await api(`/api/leads/${id}`, "PATCH", {
        consentGiven: true,
        consentEvidence: {
          basis: consentBasis,
          obtainedAt: consentDate,
          ...(consentNote.trim() ? { note: consentNote.trim() } : {}),
        },
      });
      setConsentGiven(true);
      setConsentOpen(false);
      setNotice("Açık rıza kaydedildi.");
      await load();
    } catch (e) {
      setConsentErrors({ submit: e instanceof Error ? e.message : "Açık rıza kaydedilemedi. Tekrar deneyin." });
    } finally {
      setConsentBusy(false);
    }
  }

  async function withdrawConsent() {
    setConsentBusy(true);
    setWithdrawError("");
    try {
      await api(`/api/leads/${id}`, "PATCH", { consentGiven: false });
      setConsentGiven(false);
      setWithdrawOpen(false);
      setNotice("Rıza geri çekildi olarak kaydedildi.");
      await load();
    } catch (e) {
      setWithdrawError(e instanceof Error ? e.message : "Kaydedilemedi. Tekrar deneyin.");
    } finally {
      setConsentBusy(false);
    }
  }

  function onTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next: DetailTab =
      e.key === "Home" ? "chat" : e.key === "End" ? "info" : tab === "chat" ? "info" : "chat";
    setTab(next);
    (next === "chat" ? chatTabRef : infoTabRef).current?.focus();
  }

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-6">
        <p role="status" className="animate-pulse text-sm text-muted">
          Lead ayrıntısı yükleniyor…
        </p>
      </div>
    );
  }

  if (loadError || !lead) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
        <div className="flex max-w-md flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
          <span>{loadError || "Lead yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin."}</span>
          <button type="button" className="secondary-button" onClick={() => void load({ initial: true })}>
            Tekrar dene
          </button>
        </div>
        <Link href="/leads" className="text-link text-sm">
          Lead listesine dön
        </Link>
      </div>
    );
  }

  const status = leadStatusStyle(lead.status);
  const nextStatuses = FLOW[lead.status] ?? [];
  const links = phoneLinks(lead.phone, lead.country);
  const source = lead.source;
  const hasSourceIds = Boolean(lead.campaignId || lead.adSetId || lead.adId);
  const lostBusy = statusBusy === "LOST";
  const meta = [channelLabel(lead.channel), countryName(lead.country), languageName(lead.language)].filter(Boolean);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-start gap-2 border-b border-line bg-surface px-3 py-3 sm:px-4">
        <Link
          href="/leads"
          aria-label="Lead listesine dön"
          className="-ml-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-subtle lg:hidden"
        >
          <ChevronLeft aria-hidden="true" size={22} />
        </Link>
        <div className="min-w-0 flex-1 space-y-1.5">
          <h1 className="truncate text-lg font-semibold leading-7 text-ink">
            <bdi dir="auto">{lead.name}</bdi>
          </h1>
          <StageBar stage={leadStage(lead.status)} />
          <p className="text-xs text-ink-3">
            {meta.join(" · ")}
            <span aria-hidden="true"> · </span>
            Oluşturulma: <time dateTime={lead.created}>{formatDate(lead.created)}</time>
          </p>
        </div>
      </header>

      {/* Dar kapta sekmeler; geniş kapta (≥900 px) sohbet ve lead kartı yan yana. */}
      <div
        role="tablist"
        aria-label="Lead ayrıntısı bölümleri"
        className="flex shrink-0 gap-1 border-b border-line bg-surface px-3 py-2 @[900px]:hidden"
      >
        <button
          ref={chatTabRef}
          type="button"
          role="tab"
          id={chatTabId}
          aria-selected={tab === "chat"}
          aria-controls={chatPanelId}
          tabIndex={tab === "chat" ? 0 : -1}
          onClick={() => setTab("chat")}
          onKeyDown={onTabKeyDown}
          className={`min-h-9 flex-1 rounded-lg px-3 text-sm font-medium ${tab === "chat" ? "bg-subtle text-ink" : "text-ink-3 hover:text-ink"}`}
        >
          Sohbet
        </button>
        <button
          ref={infoTabRef}
          type="button"
          role="tab"
          id={infoTabId}
          aria-selected={tab === "info"}
          aria-controls={infoPanelId}
          tabIndex={tab === "info" ? 0 : -1}
          onClick={() => setTab("info")}
          onKeyDown={onTabKeyDown}
          className={`min-h-9 flex-1 rounded-lg px-3 text-sm font-medium ${tab === "info" ? "bg-subtle text-ink" : "text-ink-3 hover:text-ink"}`}
        >
          Lead bilgileri
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          role="tabpanel"
          id={chatPanelId}
          aria-labelledby={chatTabId}
          className={`min-h-0 min-w-0 flex-1 flex-col ${tab === "chat" ? "flex" : "hidden"} @[900px]:flex`}
        >
          <LeadChat key={lead.id} leadId={lead.id} leadChannel={lead.channel} leadName={lead.name} />
        </div>

        <aside
          role="tabpanel"
          id={infoPanelId}
          aria-labelledby={infoTabId}
          className={`min-h-0 flex-1 overflow-y-auto bg-surface ${tab === "info" ? "block" : "hidden"} @[900px]:block @[900px]:w-[320px] @[900px]:flex-none @[900px]:border-l @[900px]:border-line`}
        >
          {lead.pendingFetch && (
            <section className="border-b border-line-soft bg-amber-50 px-4 py-4 text-sm text-amber-800">
              <h2 className="text-base font-semibold">Form yanıtları Meta&apos;dan çekilemedi</h2>
              <p className="mt-1">
                Lead kimliğiyle kaydedildi; ad, iletişim ve form yanıtları eksik.
                {lead.pendingFetch.error ? ` Son hata: ${lead.pendingFetch.error}` : ""}
                {` (deneme: ${lead.pendingFetch.attempts})`}
              </p>
              <p className="mt-1 text-xs">
                Meta bağlantısı yenilendiğinde ve yeni lead geldiğinde otomatik yeniden denenir.
              </p>
              <button type="button" className="primary-button mt-3" disabled={refetching} onClick={() => void refetchFromMeta()}>
                {refetching ? "Çekiliyor…" : "Meta'dan yeniden çek"}
              </button>
              {refetchError && (
                <p role="alert" className="mt-2 text-rose-700">
                  {refetchError}
                </p>
              )}
            </section>
          )}
          {refetchNotice && (
            <p role="status" className="border-b border-line-soft px-4 py-2 text-sm text-emerald-700">
              {refetchNotice}
            </p>
          )}

          <section className="border-b border-line-soft px-4 py-4">
            <h2 className="text-base font-semibold text-ink">Kişi bilgileri</h2>
            <dl className="mt-3 space-y-2.5 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Ad</dt>
                <dd className="text-right font-medium text-ink" dir="auto">{lead.name}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Telefon</dt>
                <dd className="text-right">
                  {links ? (
                    <a href={links.tel} className="font-medium text-ink underline-offset-2 hover:underline">
                      {lead.phone}
                    </a>
                  ) : (
                    <span className="font-medium text-ink">{lead.phone || "—"}</span>
                  )}
                  {links?.whatsapp && (
                    <a
                      href={links.whatsapp}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block whitespace-nowrap font-medium text-violet-700 hover:underline"
                    >
                      WhatsApp&apos;ta aç<span className="sr-only"> (yeni sekmede açılır)</span>
                    </a>
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">E-posta</dt>
                <dd className="break-all text-right font-medium text-ink">{lead.email || "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Kanal</dt>
                <dd className="text-right font-medium text-ink">{channelLabel(lead.channel)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Ülke</dt>
                <dd className="text-right font-medium text-ink">{countryName(lead.country)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Dil</dt>
                <dd className="text-right font-medium text-ink">{languageName(lead.language)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">İlgilenilen hizmet</dt>
                <dd className="text-right font-medium text-ink">{lead.interestedService || "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="shrink-0 text-muted">Kaynak kampanya</dt>
                <dd className="min-w-0 text-right">
                  {source?.campaign ? (
                    <Link
                      href={`/campaign-planner?focus=${encodeURIComponent(source.campaign.id)}`}
                      className="font-medium text-violet-700 hover:underline"
                    >
                      {source.campaign.name}
                    </Link>
                  ) : hasSourceIds ? (
                    <span className="text-muted">Panelde eşleşen kampanya yok</span>
                  ) : (
                    <span className="font-medium text-ink">—</span>
                  )}
                  {source?.adSet && <p className="text-xs text-muted">Reklam seti: {source.adSet.name}</p>}
                  {source?.ad && <p className="text-xs text-muted">Reklam: {source.ad.name}</p>}
                  {hasSourceIds && (
                    <details className="mt-1 text-left">
                      <summary className="cursor-pointer text-right text-xs text-violet-700">Teknik ayrıntı</summary>
                      <div className="mt-1 space-y-0.5 break-all font-mono text-xs text-ink-2">
                        <p>Kampanya kimliği: {lead.campaignId || "—"}</p>
                        <p>Reklam seti kimliği: {lead.adSetId || "—"}</p>
                        <p>Reklam kimliği: {lead.adId || "—"}</p>
                      </div>
                    </details>
                  )}
                </dd>
              </div>
              {lead.status === "LOST" && lead.lostReason && (
                <div className="flex justify-between gap-4 rounded-lg bg-subtle p-2">
                  <dt className="text-muted">Kayıp nedeni</dt>
                  <dd className="text-right font-medium text-ink">{lead.lostReason}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className="border-b border-line-soft px-4 py-4">
            <h2 ref={statusHeadingRef} tabIndex={-1} className="text-base font-semibold text-ink">
              Durumu güncelle
            </h2>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
              Şu anki durum: <Badge tone={status.tone}>{status.label}</Badge>
            </p>
            {nextStatuses.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {nextStatuses.map((next) => (
                  <button
                    key={next}
                    type="button"
                    className={next === "LOST" ? "secondary-button text-rose-700" : "primary-button"}
                    disabled={statusBusy !== null}
                    onClick={() => void transitionStatus(next)}
                  >
                    {statusBusy === next && next !== "LOST" ? "Güncelleniyor…" : leadTransitionLabel(next)}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">
                {lead.status === "LOST"
                  ? "Kaybedildi olarak işaretlenen lead'in durumu değiştirilemez."
                  : "Lead son aşamada; değiştirilecek başka durum yok."}
              </p>
            )}
            {statusError && (
              <p role="alert" className="mt-3 text-sm text-rose-700">
                {statusError}
              </p>
            )}
            {/* Canlı bölge hep yerinde kalır ki güncelleme ekran okuyucuya duyurulsun. */}
            <p role="status" className={statusNotice ? "mt-3 text-sm text-emerald-700" : undefined}>
              {statusNotice}
            </p>
          </section>

          <section className="border-b border-line-soft px-4 py-4" aria-labelledby="riza-baslik">
            <h2 id="riza-baslik" className="text-base font-semibold text-ink">
              Açık rıza kayıtları
            </h2>
            <p className="mt-2 text-sm text-muted">
              Pazarlama iletişimi ve Meta&apos;ya dönüşüm bildirimi yalnızca hastanın açık rızasıyla yapılır. Rızayı hasta
              verir; burada yalnızca verdiği rızayı ve nasıl alındığını kaydedersiniz. Anında Form&apos;daki kutu, talebe
              yanıt için verilen ayrı bir rızadır.
            </p>
            <div className="mt-3 space-y-3">
              {consentGiven ? (
                <p className="flex items-center gap-2 text-sm font-medium text-emerald-800">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                    <circle cx="12" cy="12" r="10" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
                  Pazarlama iletişimi ve dönüşüm ölçümü için açık rıza kayıtlı.
                </p>
              ) : (
                <p className="text-sm text-ink-2">Bu lead için pazarlama iletişimi ve dönüşüm ölçümü rızası kayıtlı değil.</p>
              )}
              {consentGiven ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={consentBusy}
                  onClick={() => {
                    setWithdrawError("");
                    setWithdrawOpen(true);
                  }}
                >
                  Rıza geri çekildi olarak kaydet
                </button>
              ) : (
                <button type="button" className="secondary-button" disabled={consentBusy} onClick={() => void openConsentDialog()}>
                  Açık rızayı kaydet
                </button>
              )}
            </div>
            {error && (
              <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="mt-3 text-sm text-emerald-800">
                {notice}
              </p>
            )}
            {(lead.consents ?? []).length > 0 && (
              <div className="mt-4 space-y-2">
                <h3 className="text-sm font-semibold text-ink">Kayıt geçmişi</h3>
                <ul className="space-y-2">
                  {(lead.consents ?? []).map((c) => {
                    const status = consentStatusStyle(c.status);
                    return (
                      <li key={c.id} className="rounded-lg border border-line p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={status.tone}>{status.label}</Badge>
                          <span className="font-medium text-ink">{consentTypeLabel(c.type)}</span>
                          <span className="text-xs text-muted">
                            {consentSourceLabel(c.source)}
                            {c.formLanguage ? ` · form dili ${languageName(c.formLanguage)}` : ""}
                            {" · "}
                            <time dateTime={c.acceptedAt ?? c.createdAt}>{formatDate(c.acceptedAt ?? c.createdAt)}</time>
                          </span>
                        </div>
                        {c.basis && <p className="mt-1 text-xs text-muted">Nasıl alındı: {consentBasisLabel(c.basis)}</p>}
                        {c.evidenceNote && <p className="mt-1 text-xs text-muted">Not: {c.evidenceNote}</p>}
                        {c.withdrawnAt && (
                          <p className="mt-1 text-xs text-ink-2">
                            Geri çekildi: <time dateTime={c.withdrawnAt}>{formatDate(c.withdrawnAt)}</time>
                          </p>
                        )}
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs font-medium text-brand-strong">Kaydedilen rıza metni</summary>
                          <p className="mt-1 whitespace-pre-line text-xs text-ink-2">{c.consentText}</p>
                        </details>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>
        </aside>
      </div>

      <Dialog
        open={consentOpen}
        title="Açık rızayı kaydet"
        description="Rızayı hasta verir; siz yalnızca verdiği rızayı kayda geçirirsiniz. Kaydetmeden önce hastanın aşağıdaki metne açıkça onay verdiğinden emin olun."
        onClose={() => {
          if (!consentBusy) setConsentOpen(false);
        }}
        footer={
          <>
            <button type="button" className="secondary-button" disabled={consentBusy} onClick={() => setConsentOpen(false)}>
              Vazgeç
            </button>
            <button type="button" className="primary-button" disabled={consentBusy} onClick={() => void recordConsent()}>
              {consentBusy ? "Kaydediliyor…" : "Açık rızayı kaydet"}
            </button>
          </>
        }
      >
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-semibold text-muted">Kaydedilecek rıza metni</p>
          <p className="mt-1 whitespace-pre-line text-sm text-slate-900">{consentStatement ?? "Yükleniyor…"}</p>
        </div>
        <fieldset
          aria-labelledby={consentBasisLegendId}
          aria-describedby={consentErrors.basis ? consentBasisErrorId : undefined}
          className="space-y-2"
        >
          <legend id={consentBasisLegendId} className="text-sm font-medium text-slate-900">
            Rıza nasıl alındı?
          </legend>
          {CONSENT_EVIDENCE_BASES.map((b) => (
            <label key={b.value} className="flex min-h-9 items-center gap-2 text-sm text-slate-800">
              <input
                type="radio"
                name="consent-basis"
                value={b.value}
                checked={consentBasis === b.value}
                aria-invalid={consentErrors.basis ? true : undefined}
                onChange={() => {
                  setConsentBasis(b.value);
                  setConsentErrors((prev) => ({ ...prev, basis: undefined }));
                }}
              />
              {b.label}
            </label>
          ))}
          {consentErrors.basis && (
            <p id={consentBasisErrorId} className="text-sm text-rose-700">
              {consentErrors.basis}
            </p>
          )}
        </fieldset>
        <label className="field">
          Rızanın alındığı tarih
          <input
            type="date"
            value={consentDate}
            max={todayInIstanbul()}
            aria-invalid={consentErrors.date ? true : undefined}
            aria-describedby={consentErrors.date ? consentDateErrorId : undefined}
            onChange={(e) => {
              setConsentDate(e.target.value);
              setConsentErrors((prev) => ({ ...prev, date: undefined }));
            }}
          />
          {consentErrors.date && (
            <span id={consentDateErrorId} className="text-sm font-normal text-rose-700">
              {consentErrors.date}
            </span>
          )}
        </label>
        <label className="field">
          Not (isteğe bağlı)
          <textarea
            rows={2}
            maxLength={500}
            value={consentNote}
            onChange={(e) => setConsentNote(e.target.value)}
            placeholder="Örn. 28 Eylül tarihli WhatsApp mesajında kampanyalardan haberdar olmak istediğini yazdı."
          />
        </label>
        {consentErrors.submit && (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {consentErrors.submit}
          </p>
        )}
      </Dialog>

      <ConfirmDialog
        open={withdrawOpen}
        title="Rıza geri çekildi olarak kaydedilsin mi?"
        description="Hastanın açık rızasını geri çektiğini kaydedersiniz. Lead pazarlama iletişimine ve Meta'ya dönüşüm bildirimine kapanır; açık kayıtlar “Geri çekildi” olarak işaretlenir."
        confirmLabel="Geri çekildi olarak kaydet"
        tone="danger"
        busy={consentBusy}
        busyLabel="Kaydediliyor…"
        error={withdrawError}
        onConfirm={() => void withdrawConsent()}
        onCancel={() => setWithdrawOpen(false)}
      />

      <Dialog
        open={lostOpen}
        title="Kaybedildi olarak işaretle"
        description="Kayıp nedeni raporlarda kullanılır. Kaybedildi olarak işaretlenen lead'in durumu sonradan değiştirilemez."
        onClose={closeLostDialog}
        footer={
          <>
            <button type="button" className="secondary-button" disabled={lostBusy} onClick={closeLostDialog}>
              Vazgeç
            </button>
            <button type="button" className="danger-button" disabled={lostBusy} onClick={() => void confirmLost()}>
              {lostBusy ? "Kaydediliyor…" : "Kaybedildi olarak işaretle"}
            </button>
          </>
        }
      >
        <fieldset
          role="radiogroup"
          aria-labelledby={lostLegendId}
          aria-invalid={lostErrors.reason ? true : undefined}
          aria-describedby={lostErrors.reason ? reasonErrorId : undefined}
          className="space-y-2"
        >
          <legend id={lostLegendId} className="mb-2 text-sm font-semibold text-slate-900">
            Kayıp nedeni
          </legend>
          {LOST_CHOICES.map((choice, index) => (
            <label key={choice} className="flex items-center gap-2 text-sm text-slate-800">
              <input
                ref={index === 0 ? firstReasonRef : undefined}
                type="radio"
                name="lost-reason"
                value={choice}
                checked={lostChoice === choice}
                onChange={() => {
                  setLostChoice(choice);
                  setLostErrors((prev) => ({ ...prev, reason: undefined, note: undefined }));
                }}
              />
              {choice}
            </label>
          ))}
          {lostErrors.reason && (
            <p id={reasonErrorId} className="text-sm text-rose-700">
              {lostErrors.reason}
            </p>
          )}
        </fieldset>
        <label className="field">
          {lostChoice === OTHER_REASON ? "Açıklama (zorunlu)" : "Not (isteğe bağlı)"}
          <textarea
            ref={noteRef}
            className="input"
            rows={3}
            maxLength={LOST_NOTE_MAX}
            value={lostNote}
            onChange={(e) => {
              setLostNote(e.target.value);
              if (lostErrors.note) setLostErrors((prev) => ({ ...prev, note: undefined }));
            }}
            aria-invalid={lostErrors.note ? true : undefined}
            aria-describedby={lostErrors.note ? noteErrorId : undefined}
          />
        </label>
        {lostErrors.note && (
          <p id={noteErrorId} className="text-sm text-rose-700">
            {lostErrors.note}
          </p>
        )}
        {lostErrors.submit && (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {lostErrors.submit}
          </p>
        )}
      </Dialog>
    </div>
  );
}
