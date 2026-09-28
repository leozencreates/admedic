"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { api } from "../../_lib/client-api";
import { formatNumber } from "../../_lib/format";
import { PageHeader } from "../../_components/ui";
import { StageBar } from "../../_components/stage-bar";
import { campaignStage, isExternalCampaign } from "../../_lib/stages";
import {
  APPROVER_ROLES,
  EDIT_ROLES,
  MAX_IMAGE_BYTES,
  MAX_PUBLISH_ROUNDS,
  REJECT_REASON_MIN,
  Feedback,
  campaignObjectiveName,
  dailyBudgetCents,
  errorText,
  languagesText,
  methodName,
  money,
  readAsDataUrl,
  warningNotes,
  type ActionResult,
  type Note,
  type OrgSettings,
  type PublishProgress,
  type StudioDraftRow,
} from "../../_lib/campaign-ui";
import { ActivationDialog, ArchiveDialog, RejectDialog, type ConfirmState, type RejectState } from "./campaign-dialogs";
import { ContentTab } from "./content-tab";
import { DecisionsTab } from "./decisions-tab";
import { OverviewTab, marketsText } from "./overview-tab";
import { PerformanceTab } from "./performance-tab";
import { PublishTab } from "./publish-tab";
import type { CampaignAction, CampaignDetail, TabKey } from "./types";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Genel" },
  { key: "content", label: "İçerik ve görsel" },
  { key: "publish", label: "Yükleme ve inceleme" },
  { key: "performance", label: "Performans" },
  { key: "decisions", label: "Ajan kararları" },
];
const TAB_KEYS = TABS.map((t) => t.key);
const FEEDBACK_ID = "campaign-feedback";

function isTab(value: string | null): value is TabKey {
  return value != null && (TAB_KEYS as string[]).includes(value);
}

/** "Diğer işlemler": yalnızca geçerli ikincil işlemler; Esc ve dışarı tıklama kapatır. */
function MoreActions({ items, disabled }: { items: { key: string; label: string; onSelect: () => void }[]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div
      ref={wrapRef}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="ghost-button"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        Diğer işlemler
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      {open && (
        <ul
          id={listId}
          className="absolute left-0 z-20 mt-1 min-w-52 rounded-lg border border-line bg-surface p-1 shadow-lg sm:left-auto sm:right-0"
        >
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className="block w-full rounded-md px-3 py-2 text-left text-sm text-ink hover:bg-subtle"
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Kampanya sayfası (K5-C, ADR-0020): yaşam döngüsü şeridi + tek sıradaki eylem, sekmelerde plan, içerik,
 * Meta'ya yükleme/inceleme, performans ve ajan kararları. Tüm işlemler mevcut kampanya uçlarını çağırır.
 */
export default function CampaignPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [conns, setConns] = useState<{ id: string; status: string }[]>([]);
  const [role, setRole] = useState("");
  const [canApproveSpend, setCanApproveSpend] = useState(false);
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [approvedDrafts, setApprovedDrafts] = useState<StudioDraftRow[]>([]);
  const [busy, setBusy] = useState<CampaignAction | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [liveProgress, setLiveProgress] = useState<PublishProgress | null>(null);
  const [activation, setActivation] = useState<ConfirmState | null>(null);
  const [archiving, setArchiving] = useState<ConfirmState | null>(null);
  const [rejecting, setRejecting] = useState<RejectState | null>(null);
  const [tab, setTab] = useState<TabKey>("overview");
  const tabsId = useId();
  const rejectFieldId = useId();

  /** Sayfa verisi paralel okunur; her kaynağın hatası ayrı ele alınır. */
  async function load() {
    const [detailRes, connsRes, sessionRes, settingsRes, studioRes] = await Promise.allSettled([
      api<CampaignDetail>(`/api/campaigns/${encodeURIComponent(id)}`),
      api<{ connections: { id: string; status: string }[] }>("/api/meta/connections"),
      api<{ actor: { role: string; canApproveSpend?: boolean } | null }>("/api/session"),
      api<{ settings: OrgSettings }>("/api/org/settings"),
      api<{ drafts: StudioDraftRow[] }>("/api/studio"),
    ]);
    if (detailRes.status === "fulfilled") {
      setDetail(detailRes.value);
      setLoadError("");
    } else {
      // Önceki veri korunur; hata ayrıca gösterilir.
      setLoadError(errorText(detailRes.reason, "Kampanya yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin."));
    }
    setConns(connsRes.status === "fulfilled" ? (connsRes.value.connections ?? []) : []);
    const actor = sessionRes.status === "fulfilled" ? sessionRes.value.actor : null;
    setRole(actor?.role ?? "");
    setCanApproveSpend(Boolean(actor?.canApproveSpend));
    setSettings(settingsRes.status === "fulfilled" ? settingsRes.value.settings : null);
    setApprovedDrafts(
      studioRes.status === "fulfilled" ? studioRes.value.drafts.filter((d) => d.status === "APPROVED") : [],
    );
  }
  async function reload() {
    setReloading(true);
    await load();
    setReloading(false);
  }

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get("tab");
    if (isTab(initial)) setTab(initial);
    void (async () => {
      await load();
      setLoading(false);
    })();
    // `load` her çizimde yeniden oluşur; yalnızca kampanya değişince yüklenir.
  }, [id]);

  // Dar ekranda sekme şeridi yatay kayar; seçili sekme görünür alana getirilir (ör. `?tab=performance`).
  useEffect(() => {
    if (loading) return;
    document.getElementById(`${tabsId}-tab-${tab}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, loading, tabsId]);

  function chooseTab(next: TabKey, focus = false) {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
    if (focus) window.requestAnimationFrame(() => document.getElementById(`${tabsId}-tab-${next}`)?.focus());
  }
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next == null) return;
    e.preventDefault();
    chooseTab(TABS[next].key, true);
  }
  /** Diyalog kapandıktan sonra tetikleyen düğme kaybolmuş olabilir; odak sonuç mesajına taşınır. */
  function focusFeedback() {
    window.requestAnimationFrame(() => document.getElementById(FEEDBACK_ID)?.focus({ preventScroll: true }));
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Kampanya" crumbs={[{ label: "Kampanyalar", href: "/campaigns" }]} />
        <div role="status" aria-label="Kampanya yükleniyor" className="h-40 animate-pulse rounded-xl bg-slate-200/60" />
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="space-y-6">
        <PageHeader title="Kampanya" crumbs={[{ label: "Kampanyalar", href: "/campaigns" }]} />
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {loadError || "Kampanya yüklenemedi."} Kampanya silinmiş ya da başka bir çalışma alanına ait olabilir.
          <button type="button" onClick={reload} disabled={reloading} className="secondary-button">
            {reloading ? "Yükleniyor…" : "Tekrar dene"}
          </button>
          <Link href="/campaigns" className="text-link font-medium underline-offset-2 hover:underline">
            Kampanyalara dön
          </Link>
        </div>
      </div>
    );
  }

  const c = detail.campaign;
  const w = c.workflowStatus;
  const canEdit = EDIT_ROLES.includes(role);
  const canApprove = APPROVER_ROLES.includes(role);
  const progress = liveProgress ?? c.publish;
  const partial = w === "APPROVED" && progress.status === "IN_PROGRESS";
  const isBusy = busy != null;
  // Meta'da oluşturulmuş kampanya (bu akıştan geçmemiş): iş akışı adımları uygulanmaz (ADR-0020).
  const external = isExternalCampaign({ workflowStatus: w, publish: progress });
  const stage = campaignStage(w, {
    publishIncomplete: partial,
    metaPaused: w === "ACTIVE" && c.status === "PAUSED",
    external,
    metaStatus: c.status,
  });
  const daily = dailyBudgetCents(c);
  const summary = [
    campaignObjectiveName(c.objective),
    c.plan?.markets?.length ? marketsText(c.plan.markets) : null,
    c.plan?.languages?.length ? languagesText(c.plan.languages) : null,
    daily != null ? `${money(daily, c.currency)}/gün` : null,
    c.plan?.conversionMethod ? methodName(c.plan.conversionMethod) : null,
  ].filter(Boolean);
  const metaDisconnected = conns.some((x) => x.status === "EXPIRED" || x.status === "REVOKED");

  /** İşlem: sonuç (başarı, uyarı ya da hata) başlığın altında gösterilir. */
  async function runAction(action: CampaignAction, path: string, body: object, successText: string, fallbackError: string) {
    setBusy(action);
    setNotes([]);
    try {
      const result = await api<ActionResult>(`/api/campaigns/${c.id}/${path}`, "POST", body);
      setNotes([{ tone: "success", text: successText }, ...warningNotes(result)]);
      await load();
    } catch (e) {
      setNotes([{ tone: "error", text: errorText(e, fallbackError) }]);
    }
    setBusy(null);
  }
  /** Meta reklam incelemesini (effective_status + red gerekçeleri) şimdi yeniler. */
  async function refreshReview() {
    setBusy("review");
    setNotes([]);
    try {
      const result = await api<{ campaigns: { status: string; newlyDisapproved: number; error?: string }[] }>(
        "/api/meta/review-sync",
        "POST",
        { campaignId: c.id },
      );
      const row = result.campaigns[0];
      if (row?.error) setNotes([{ tone: "error", text: `Meta incelemesi yenilenemedi: ${row.error}` }]);
      else if (row?.status === "NO_ADS")
        setNotes([{ tone: "warning", text: "Bu kampanyanın Meta'ya yüklenmiş reklamı yok; incelenecek reklam bulunamadı." }]);
      else if (row?.newlyDisapproved)
        setNotes([{ tone: "warning", text: `Meta ${formatNumber(row.newlyDisapproved)} reklamı reddetti; gerekçeler "Yükleme ve inceleme" sekmesinde.` }]);
      else setNotes([{ tone: "success", text: "Meta inceleme durumu güncellendi." }]);
      await load();
    } catch (e) {
      setNotes([{ tone: "error", text: errorText(e, "Meta incelemesi yenilenemedi. Birkaç dakika sonra tekrar deneyin.") }]);
    }
    setBusy(null);
  }
  /** Meta'ya kapalı yükleme: sunucu süre dolunca ilerlemeyi kaydeder; kalan adımlar için otomatik devam edilir. */
  async function publish() {
    setBusy("publish");
    setNotes([]);
    try {
      let last: ActionResult | undefined;
      for (let round = 0; round < MAX_PUBLISH_ROUNDS; round++) {
        last = await api<ActionResult>(`/api/campaigns/${c.id}/publish`, "POST", { action: "PUBLISH" });
        const p = last.publish?.progress;
        if (p) setLiveProgress(p);
        if (last.publish?.status !== "IN_PROGRESS") break;
      }
      const pending = last?.publish?.status === "IN_PROGRESS";
      setNotes([
        pending
          ? { tone: "warning", text: "Meta'ya yükleme henüz bitmedi. Kaldığı yerden sürdürmek için \"Yüklemeye devam et\" düğmesine basın." }
          : { tone: "success", text: "Kampanya Meta'ya kapalı olarak yüklendi. Harcama, kampanya etkinleştirildiğinde başlar." },
        ...warningNotes(last),
      ]);
    } catch (e) {
      setNotes([{ tone: "error", text: errorText(e, "Meta'ya yükleme tamamlanamadı. \"Yüklemeye devam et\" ile kaldığı yerden sürdürebilirsiniz.") }]);
    }
    await load();
    // Canlı ilerleme yalnızca yükleme sürerken gösterilir; sonrasında sunucudaki güncel durum (son hata dahil) geçerlidir.
    setLiveProgress(null);
    setBusy(null);
  }
  async function uploadImage(file: File | undefined) {
    if (!file) return;
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      setNotes([{ tone: "error", text: "Yalnızca JPEG veya PNG görsel yüklenebilir. Başka bir dosya seçin." }]);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setNotes([{ tone: "error", text: "Görsel en fazla 3 MB olabilir. Daha küçük bir dosya seçin." }]);
      return;
    }
    setBusy("image");
    setNotes([]);
    try {
      const dataBase64 = await readAsDataUrl(file);
      const result = await api<ActionResult>(`/api/campaigns/${c.id}/image`, "POST", { filename: file.name, dataBase64 });
      setNotes([{ tone: "success", text: "Görsel yüklendi." }, ...warningNotes(result)]);
      await load();
    } catch (e) {
      setNotes([{ tone: "error", text: errorText(e, "Görsel yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.") }]);
    }
    setBusy(null);
  }
  async function saveContent(draftIds: string[], landingUrl: string): Promise<boolean> {
    if (draftIds.length === 0) {
      setNotes([{ tone: "error", text: "En az bir onaylı reklam içeriği seçin." }]);
      return false;
    }
    setBusy("content");
    setNotes([]);
    let ok = false;
    try {
      const result = await api<ActionResult>(`/api/campaigns/${c.id}/content`, "PUT", {
        draftIds,
        landingUrl: landingUrl.trim() ? landingUrl.trim() : null,
      });
      ok = true;
      setNotes([{ tone: "success", text: "Reklam içeriği kampanyaya bağlandı." }, ...warningNotes(result)]);
      await load();
    } catch (e) {
      setNotes([{ tone: "error", text: errorText(e, "İçerik kampanyaya bağlanamadı. Bağlantınızı kontrol edip tekrar deneyin.") }]);
    }
    setBusy(null);
    return ok;
  }

  function openActivation() {
    setNotes([]);
    setActivation({ busy: false, error: "" });
    // Onay penceresindeki aylık toplam güncel olsun (başka sekmede değişmiş olabilir).
    api<{ settings: OrgSettings }>("/api/org/settings").then(
      (o) => setSettings(o.settings),
      () => undefined,
    );
  }
  async function confirmActivation() {
    if (!activation || activation.busy) return;
    setActivation({ ...activation, busy: true, error: "" });
    setBusy("activate");
    try {
      const result = await api<ActionResult>(`/api/campaigns/${c.id}/publish`, "POST", { action: "ACTIVATE" });
      setActivation(null);
      setNotes([
        {
          tone: "success",
          text:
            daily != null
              ? `Kampanya etkinleştirildi; günlük ${money(daily, c.currency)} harcama başladı.`
              : "Kampanya etkinleştirildi; harcama başladı.",
        },
        ...warningNotes(result),
      ]);
      await load();
      focusFeedback();
    } catch (e) {
      setActivation((prev) =>
        prev ? { ...prev, busy: false, error: errorText(e, "Kampanya etkinleştirilemedi. Birkaç dakika sonra tekrar deneyin.") } : prev,
      );
    }
    setBusy(null);
  }
  function openArchive() {
    setNotes([]);
    setArchiving({ busy: false, error: "" });
  }
  async function confirmArchive() {
    if (!archiving || archiving.busy) return;
    setArchiving({ ...archiving, busy: true, error: "" });
    setBusy("archive");
    try {
      await api<ActionResult>(`/api/campaigns/${c.id}/publish`, "POST", { action: "ARCHIVE" });
      setArchiving(null);
      setNotes([{ tone: "success", text: "Kampanya arşivlendi; Meta'da duraklatıldı ve harcama yapmaz." }]);
      await load();
      focusFeedback();
    } catch (e) {
      setArchiving((prev) =>
        prev ? { ...prev, busy: false, error: errorText(e, "Kampanya arşivlenemedi. Meta bağlantısını kontrol edip tekrar deneyin.") } : prev,
      );
    }
    setBusy(null);
  }
  function openReject() {
    setNotes([]);
    setRejecting({ reason: "", fieldError: "", error: "", busy: false });
  }
  async function confirmReject() {
    if (!rejecting || rejecting.busy) return;
    const reason = rejecting.reason.trim();
    if (reason.length < REJECT_REASON_MIN) {
      setRejecting({
        ...rejecting,
        fieldError: `Düzeltme gerekçesi en az ${REJECT_REASON_MIN} karakter olmalı. Neyin düzeltilmesi gerektiğini kısaca yazın.`,
      });
      window.requestAnimationFrame(() => document.getElementById(rejectFieldId)?.focus());
      return;
    }
    setRejecting({ ...rejecting, busy: true, error: "", fieldError: "" });
    setBusy("reject");
    try {
      await api(`/api/campaigns/${c.id}/reject`, "POST", { reason });
      setRejecting(null);
      setNotes([
        { tone: "success", text: "Düzeltme istendi. Gerekçe kampanya adının altında görünüyor; kampanya düzeltildikten sonra yeniden onaya gönderilebilir." },
      ]);
      await load();
      focusFeedback();
    } catch (e) {
      setRejecting((prev) => (prev ? { ...prev, busy: false, error: errorText(e, "Düzeltme isteği kaydedilemedi. Bağlantınızı kontrol edip tekrar deneyin.") } : prev));
    }
    setBusy(null);
  }

  // ── Başlık: tek sıradaki eylem + "Diğer işlemler" ───────────────────────────
  let primary: ReactNode = null;
  let secondary: ReactNode = null;
  let hint: string | null = null;
  if (external) {
    hint = "Bu kampanya Meta'da oluşturuldu; onay ve Meta'ya yükleme adımları uygulanmaz. Durumu ve performansı Meta'dan eşitlenir.";
  } else if (w === "DRAFT" || w === "REJECTED") {
    if (!canEdit) hint = "Onaya göndermeyi hesap sahibi, yönetici veya reklam uzmanı yapar.";
    else if (c.readiness && !c.readiness.ready)
      primary = (
        <button type="button" className="primary-button" disabled={isBusy} onClick={() => chooseTab("content", true)}>
          Hazırlığı tamamla
        </button>
      );
    else
      primary = (
        <button
          type="button"
          className="primary-button"
          disabled={isBusy}
          onClick={() =>
            runAction("submit", "submit", {},
              "Kampanya onaya gönderildi. Hesap sahibi veya yönetici onayladığında Meta'ya yükleyebilirsiniz.",
              "Kampanya onaya gönderilemedi. İçeriğin ve görselin bağlı olduğunu kontrol edip tekrar deneyin.")
          }
        >
          {busy === "submit" ? "Gönderiliyor…" : "Onaya gönder"}
        </button>
      );
  } else if (w === "IN_REVIEW") {
    if (!canApprove) hint = "Onay bekliyor · Onayı hesap sahibi veya yönetici verir.";
    else {
      primary = (
        <button
          type="button"
          className="primary-button"
          disabled={isBusy}
          onClick={() =>
            runAction("approve", "approve", {},
              "Kampanya onaylandı. Şimdi Meta'ya kapalı olarak yükleyebilirsiniz.",
              "Kampanya onaylanamadı. Birkaç dakika sonra tekrar deneyin.")
          }
        >
          {busy === "approve" ? "Onaylanıyor…" : "Onayla"}
        </button>
      );
      secondary = (
        <button type="button" className="secondary-button" disabled={isBusy} onClick={openReject}>
          Düzeltme iste
        </button>
      );
    }
  } else if (w === "APPROVED") {
    if (!canEdit) hint = "Meta'ya yüklemeyi hesap sahibi, yönetici veya reklam uzmanı yapar.";
    else
      primary = (
        <button type="button" className="primary-button" disabled={isBusy} onClick={publish}>
          {busy === "publish" ? "Meta'ya yükleniyor…" : partial ? "Yüklemeye devam et" : "Meta'ya yükle (kapalı)"}
        </button>
      );
  } else if (w === "PUBLISHED_PAUSED") {
    if (!canApproveSpend) hint = "Harcama yetkisi gerekli: yalnızca hesap sahibi veya yetki verdiği üye etkinleştirebilir.";
    else
      primary = (
        <button type="button" className="primary-button" disabled={isBusy} onClick={openActivation}>
          {busy === "activate" ? "Etkinleştiriliyor…" : "Etkinleştir"}
        </button>
      );
  }
  const more: { key: string; label: string; onSelect: () => void }[] = [];
  if (w === "ACTIVE" && canEdit)
    more.push({
      key: "pause",
      label: busy === "pause" ? "Duraklatılıyor…" : "Duraklat",
      onSelect: () =>
        runAction("pause", "publish", { action: "PAUSE" },
          "Kampanya duraklatıldı; harcama durdu. Harcama yetkisi olan kişi yeniden etkinleştirebilir.",
          "Kampanya duraklatılamadı. Meta bağlantısını kontrol edip tekrar deneyin."),
    });
  const canRefreshReview = ["PUBLISHED_PAUSED", "ACTIVE"].includes(w) && c.ads > 0 && canEdit;
  if (canRefreshReview) more.push({ key: "review", label: "Meta incelemesini yenile", onSelect: refreshReview });
  if (canEdit && (partial || w === "PUBLISHED_PAUSED" || w === "ACTIVE"))
    more.push({ key: "archive", label: "Arşivle", onSelect: openArchive });
  const busyLabel: Partial<Record<CampaignAction, string>> = {
    pause: "Duraklatılıyor…",
    review: "Meta incelemesi yenileniyor…",
    archive: "Arşivleniyor…",
  };
  const actions =
    primary || secondary || hint || more.length ? (
      <>
        {hint && <p className="max-w-xs text-xs text-ink-3">{hint}</p>}
        {primary}
        {secondary}
        <MoreActions items={more} disabled={isBusy} />
        {busy && busyLabel[busy] && (
          <span role="status" className="text-xs text-ink-3">
            {busyLabel[busy]}
          </span>
        )}
      </>
    ) : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title={c.name}
        crumbs={[{ label: "Kampanyalar", href: "/campaigns" }]}
        description={
          <>
            <span className="block">
              <StageBar stage={stage} />
            </span>
            {summary.length > 0 && <span className="mt-1.5 block text-sm text-ink-2">{summary.join(" · ")}</span>}
          </>
        }
        actions={actions}
      />
      {c.rejectionReason && w === "REJECTED" && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <p className="font-medium">Düzeltme gerekçesi</p>
          <p className="mt-0.5">{c.rejectionReason}</p>
        </div>
      )}
      {metaDisconnected && (
        <Link href="/meta-connections" className="block rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 hover:bg-rose-100">
          Meta bağlantısı kesildi. Kampanya işlemlerini sürdürmek için Meta bağlantıları sayfasından bağlantıyı yenileyin.
        </Link>
      )}
      {loadError && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          Kampanya yenilenemedi; gösterilen bilgiler güncel olmayabilir.
          <button type="button" onClick={reload} disabled={reloading} className="secondary-button min-h-9 px-3 py-1.5 text-xs">
            {reloading ? "Yükleniyor…" : "Tekrar dene"}
          </button>
        </div>
      )}
      <Feedback id={FEEDBACK_ID} notes={notes} className="" />

      <div>
        {/* Telefonda sekmeler yatay kayar; sağ kenardaki solma kaydırılabildiğini gösterir. */}
        <div className="scroll-cue-x -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <div role="tablist" aria-label="Kampanya bölümleri" className="flex min-w-max gap-1 border-b border-line">
            {TABS.map((t, i) => {
              const selected = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  id={`${tabsId}-tab-${t.key}`}
                  aria-selected={selected}
                  aria-controls={`${tabsId}-panel-${t.key}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => chooseTab(t.key)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  className={`-mb-px min-h-10 whitespace-nowrap border-b-2 px-3 text-sm font-medium ${
                    selected ? "border-brand text-ink" : "border-transparent text-ink-3 hover:text-ink"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
        <div role="tabpanel" id={`${tabsId}-panel-${tab}`} aria-labelledby={`${tabsId}-tab-${tab}`} className="pt-6">
          {tab === "overview" && <OverviewTab campaign={c} adSets={detail.adSets} onOpenContent={() => chooseTab("content", true)} />}
          {tab === "content" && (
            <ContentTab
              campaign={c}
              canEdit={canEdit}
              busy={busy}
              approvedDrafts={approvedDrafts}
              onSaveContent={saveContent}
              onUploadImage={(file) => void uploadImage(file)}
            />
          )}
          {tab === "publish" && (
            <PublishTab campaign={c} progress={progress} busy={busy} canRefreshReview={canRefreshReview} onRefreshReview={refreshReview} />
          )}
          {tab === "performance" && <PerformanceTab detail={detail} />}
          {tab === "decisions" && <DecisionsTab decisions={detail.decisions} budgetChanges={detail.budgetChanges} currency={c.currency} />}
        </div>
      </div>

      <ActivationDialog
        campaign={c}
        settings={settings}
        state={activation}
        onConfirm={confirmActivation}
        onCancel={() => setActivation(null)}
      />
      <ArchiveDialog campaign={c} state={archiving} onConfirm={confirmArchive} onCancel={() => setArchiving(null)} />
      <RejectDialog
        campaign={c}
        state={rejecting}
        fieldId={rejectFieldId}
        onChange={(reason) =>
          setRejecting((prev) =>
            prev
              ? { ...prev, reason, fieldError: prev.fieldError && reason.trim().length >= REJECT_REASON_MIN ? "" : prev.fieldError }
              : prev,
          )
        }
        onConfirm={confirmReject}
        onCancel={() => setRejecting(null)}
      />
    </div>
  );
}
