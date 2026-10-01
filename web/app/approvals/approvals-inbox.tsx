"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "../_lib/client-api";
import { formatDate, formatDuration, formatMoney, formatNumber } from "../_lib/format";
import { campaignStage } from "../_lib/stages";
import { ConfirmDialog, Dialog } from "../_components/dialog";
import { IntroPanel } from "../_components/ui";
import { StageBar } from "../_components/stage-bar";

export type InboxKind = "CONTENT" | "CAMPAIGN" | "ACTIVATION" | "RECOMMENDATION" | "LEAD_PROPOSAL";

export interface InboxItem {
  kind: InboxKind;
  id: string;
  title: string;
  detail: string | null;
  submittedBy: string | null;
  submittedByLabel: string;
  waitingSince: string;
  actors: string;
  href: string;
  version: number | null;
  dailyBudgetCents: number | null;
  currency: string;
  workflowStatus: string | null;
}

export interface InboxCorrection {
  kind: "CONTENT" | "CAMPAIGN";
  id: string;
  title: string;
  reason: string | null;
  rejectedBy: string | null;
  rejectedAt: string;
  href: string;
}

const KIND_LABEL: Record<InboxKind, { tab: string; row: string }> = {
  CONTENT: { tab: "İçerik", row: "İçerik onayı" },
  CAMPAIGN: { tab: "Kampanya", row: "Kampanya onayı" },
  ACTIVATION: { tab: "Etkinleştirme", row: "Etkinleştirme" },
  RECOMMENDATION: { tab: "Öneri", row: "Bütçe önerisi" },
  LEAD_PROPOSAL: { tab: "Lead önerisi", row: "Lead takımı önerisi" },
};
const KINDS: InboxKind[] = ["CONTENT", "CAMPAIGN", "ACTIVATION", "RECOMMENDATION", "LEAD_PROPOSAL"];

type Pending =
  | { type: "reject"; item: InboxItem }
  | { type: "activate"; item: InboxItem }
  | { type: "dismiss"; item: InboxItem };

/**
 * Onay kutusu (ADR-0018): her satırda en fazla bir birincil ve bir ikincil eylem.
 * Onay ve düzeltme isteği mevcut API uçlarından geçer; yetki ve durum sunucuda yeniden denetlenir.
 * Başarılı işlemden sonra satır listeden çıkar, sayfa sunucudan tazelenir ve sonuç duyurulur (aria-live).
 */
export function ApprovalsInbox({
  items: initialItems,
  corrections,
  canApprove,
  canApproveSpend,
  monthly,
  now,
}: {
  items: InboxItem[];
  corrections: InboxCorrection[];
  canApprove: boolean;
  canApproveSpend: boolean;
  monthly: { committedCents: number; capCents: number | null; currency: string; monthDays: number };
  now: number;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [filter, setFilter] = useState<InboxKind | "ALL">("ALL");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [reason, setReason] = useState("");

  const counts = useMemo(() => {
    const c: Record<InboxKind, number> = { CONTENT: 0, CAMPAIGN: 0, ACTIVATION: 0, RECOMMENDATION: 0, LEAD_PROPOSAL: 0 };
    for (const item of items) c[item.kind] += 1;
    return c;
  }, [items]);
  const visible = items
    .filter((item) => filter === "ALL" || item.kind === filter)
    .sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince));

  function done(item: InboxItem, message: string) {
    setItems((list) => list.filter((x) => !(x.kind === item.kind && x.id === item.id)));
    setAnnounce(message);
    router.refresh();
  }

  async function run(item: InboxItem, call: () => Promise<unknown>, message: string) {
    setBusyId(item.id);
    setRowError(null);
    try {
      await call();
      done(item, message);
    } catch (e) {
      setRowError({ id: item.id, text: e instanceof Error ? e.message : "İşlem tamamlanamadı. Bağlantınızı kontrol edip tekrar deneyin." });
    } finally {
      setBusyId(null);
    }
  }

  function approve(item: InboxItem) {
    const name = `"${item.title}"`;
    if (item.kind === "CONTENT")
      return run(item, () => api(`/api/studio/${item.id}`, "PATCH", { action: "approve", version: item.version }), `${name} içeriği onaylandı.`);
    if (item.kind === "CAMPAIGN")
      return run(item, () => api(`/api/campaigns/${item.id}/approve`, "POST"), `${name} kampanyası onaylandı; Meta'ya yüklenmeye hazır.`);
    if (item.kind === "RECOMMENDATION")
      return run(item, () => api(`/api/recommendations/${item.id}/approve`, "POST"), `${name} önerisi onaylandı; Öneriler sayfasından uygulanabilir.`);
    // Lead takımı önerisi (ADR-0029): onay kampanya oluşturmaz; ret gerekçesi Lead takımı sayfasında yazılır.
    if (item.kind === "LEAD_PROPOSAL")
      return run(
        item,
        () => api(`/api/lead-team/proposals/${item.id}`, "POST", { decision: "APPROVE" }),
        `${name} önerisi onaylandı. Kampanyayı Yeni kampanya sayfasından kurabilirsiniz.`,
      );
  }

  function openDialog(next: Pending) {
    setPending(next);
    setDialogError("");
    setReason("");
  }

  async function confirmDialog() {
    if (!pending) return;
    const { item } = pending;
    setDialogBusy(true);
    setDialogError("");
    try {
      if (pending.type === "reject") {
        const text = reason.trim();
        if (text.length < 3) {
          setDialogError("Neyin düzeltilmesi gerektiğini en az birkaç kelimeyle yazın.");
          setDialogBusy(false);
          return;
        }
        if (item.kind === "CONTENT")
          await api(`/api/studio/${item.id}`, "PATCH", { action: "reject", version: item.version, reason: text });
        else await api(`/api/campaigns/${item.id}/reject`, "POST", { reason: text });
        done(item, `"${item.title}" için düzeltme istendi; gönderen bilgilendirildi.`);
      } else if (pending.type === "activate") {
        await api(`/api/campaigns/${item.id}/publish`, "POST", { action: "ACTIVATE" });
        done(
          item,
          item.dailyBudgetCents != null
            ? `"${item.title}" etkinleştirildi; günlük ${formatMoney(item.dailyBudgetCents, item.currency)} harcama başladı.`
            : `"${item.title}" etkinleştirildi; harcama başladı.`,
        );
      } else {
        await api(`/api/recommendations/${item.id}`, "PATCH", { status: "REJECTED" });
        done(item, `"${item.title}" önerisi yok sayıldı.`);
      }
      setPending(null);
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : "İşlem tamamlanamadı. Bağlantınızı kontrol edip tekrar deneyin.");
    } finally {
      setDialogBusy(false);
    }
  }

  function actionsFor(item: InboxItem) {
    const busy = busyId === item.id;
    const nameRef = `onay-${item.kind}-${item.id}`;
    const open = (
      <Link href={item.href} className="secondary-button" aria-describedby={nameRef}>
        Aç
      </Link>
    );
    if (item.kind === "ACTIVATION") {
      if (!canApproveSpend) return <>{open}</>;
      return (
        <>
          <button type="button" className="primary-button" disabled={busy} aria-describedby={nameRef} onClick={() => openDialog({ type: "activate", item })}>
            Etkinleştir
          </button>
          {open}
        </>
      );
    }
    if (!canApprove) return <>{open}</>;
    return (
      <>
        <button type="button" className="primary-button" disabled={busy} aria-describedby={nameRef} onClick={() => void approve(item)}>
          {busy ? "Onaylanıyor…" : "Onayla"}
        </button>
        {item.kind === "LEAD_PROPOSAL" ? null : item.kind === "RECOMMENDATION" ? (
          <button type="button" className="secondary-button" disabled={busy} aria-describedby={nameRef} onClick={() => openDialog({ type: "dismiss", item })}>
            Yok say
          </button>
        ) : (
          <button type="button" className="secondary-button" disabled={busy} aria-describedby={nameRef} onClick={() => openDialog({ type: "reject", item })}>
            Düzeltme iste
          </button>
        )}
        <Link href={item.href} className="ghost-button" aria-describedby={nameRef}>
          Aç
        </Link>
      </>
    );
  }

  const activation = pending?.type === "activate" ? pending.item : null;
  const monthlyOfThis = activation?.dailyBudgetCents != null ? activation.dailyBudgetCents * monthly.monthDays : null;
  const sameCurrency = activation ? activation.currency === monthly.currency : false;
  const monthlyTotal = monthlyOfThis != null && sameCurrency ? monthly.committedCents + monthlyOfThis : null;
  const exceeds = monthlyTotal != null && monthly.capCents != null && monthlyTotal > monthly.capCents;

  return (
    <div className="space-y-6">
      <p aria-live="polite" role="status" className={announce ? "rounded-lg border border-ok-line bg-ok-bg px-4 py-3 text-sm text-ok" : "sr-only"}>
        {announce}
      </p>

      {items.length === 0 && corrections.length === 0 ? (
        canApprove ? (
          <IntroPanel title="Onayınızı bekleyen iş yok">
            Ekibiniz bir reklam içeriğini ya da kampanyayı onaya gönderdiğinde, bir kampanya Meta&apos;ya kapalı yüklendiğinde
            ya da yeni bir bütçe önerisi geldiğinde burada görünür.
          </IntroPanel>
        ) : (
          <IntroPanel title="Onayda bekleyen işiniz yok">
            Onaya gönderdiğiniz reklam içerikleri ve kampanyalar burada izlenir. Onaylayan kişi düzeltme isterse gerekçesiyle
            birlikte burada görünür.
          </IntroPanel>
        )
      ) : null}

      {corrections.length > 0 ? (
        <section aria-labelledby="duzeltme-baslik" className="studio-card">
          <h2 id="duzeltme-baslik">Düzeltme istenenler</h2>
          <p className="mt-1 text-sm text-ink-2">Düzeltip yeniden onaya gönderin.</p>
          <ul className="mt-3 divide-y divide-line-soft">
            {corrections.map((c) => (
              <li key={`${c.kind}-${c.id}`} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-xs text-ink-3">{c.kind === "CONTENT" ? "Reklam içeriği" : "Kampanya"}</p>
                  <p className="break-words font-medium text-ink">{c.title}</p>
                  <p className="mt-0.5 break-words text-sm text-ink-2">
                    {c.reason ? `Gerekçe: ${c.reason}` : "Gerekçe yazılmamış."}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {c.rejectedBy ? `${c.rejectedBy} · ` : ""}
                    {formatDate(c.rejectedAt)}
                  </p>
                </div>
                <Link href={c.href} className="primary-button self-start">
                  Düzelt<span className="sr-only">: {c.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {items.length > 0 ? (
        <section aria-labelledby="bekleyen-baslik" className="studio-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="bekleyen-baslik">{canApprove ? "Bekleyen işler" : "Onayda bekleyenler"}</h2>
            <p className="text-sm text-ink-3">{formatNumber(items.length)} iş</p>
          </div>
          <div role="group" aria-label="Türe göre süz" className="mt-3 flex flex-wrap gap-2">
            {(["ALL", ...KINDS] as const)
              .filter((kind) => kind === "ALL" || counts[kind] > 0)
              .map((kind) => {
                const selected = filter === kind;
                const count = kind === "ALL" ? items.length : counts[kind];
                return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setFilter(kind)}
                    className={`inline-flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium max-sm:min-h-11 ${
                      selected ? "border-brand-200 bg-brand-50 text-brand-700" : "border-btn-line bg-surface text-neutral hover:bg-subtle"
                    }`}
                  >
                    {kind === "ALL" ? "Tümü" : KIND_LABEL[kind].tab}
                    <span className="tabular-nums text-ink-3">{formatNumber(count)}</span>
                  </button>
                );
              })}
          </div>
          {visible.length === 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-ink-2">
              <p>Süzgeçle eşleşen iş kalmadı.</p>
              <button type="button" className="ghost-button" onClick={() => setFilter("ALL")}>
                Süzgeci temizle
              </button>
            </div>
          ) : (
            <ul className="mt-2 divide-y divide-line-soft">
              {visible.map((item) => {
                const nameRef = `onay-${item.kind}-${item.id}`;
                const waited = now - Date.parse(item.waitingSince);
                return (
                  <li key={`${item.kind}-${item.id}`} className="flex flex-col gap-3 py-4 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
                    <div className="min-w-0 space-y-1">
                      <p className="text-xs font-medium text-ink-3">{KIND_LABEL[item.kind].row}</p>
                      <p id={nameRef} className="break-words font-medium text-ink">
                        {item.title}
                      </p>
                      {item.workflowStatus ? <StageBar stage={campaignStage(item.workflowStatus)} /> : null}
                      {item.detail ? <p className="break-words text-sm text-ink-2">{item.detail}</p> : null}
                      <p className="text-xs text-ink-3">
                        {item.submittedBy ? `${item.submittedByLabel}: ${item.submittedBy} · ` : ""}
                        <time dateTime={item.waitingSince}>{formatDuration(waited)}</time> bekliyor
                        {item.kind === "ACTIVATION" && !canApproveSpend ? ` · ${item.actors} etkinleştirebilir` : ""}
                        {item.kind !== "ACTIVATION" && !canApprove ? ` · ${item.actors} onaylar` : ""}
                      </p>
                      {rowError?.id === item.id ? (
                        <p role="alert" className="text-sm text-bad">
                          {rowError.text}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">{actionsFor(item)}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      <Dialog
        open={pending?.type === "reject"}
        title="Düzeltme iste"
        description={pending ? <>&quot;{pending.item.title}&quot; gönderene geri döner. Neyin düzeltilmesi gerektiğini yazın.</> : undefined}
        onClose={() => (dialogBusy ? undefined : setPending(null))}
        footer={
          <>
            <button type="button" className="secondary-button" disabled={dialogBusy} onClick={() => setPending(null)}>
              Vazgeç
            </button>
            <button type="button" className="primary-button" disabled={dialogBusy} onClick={() => void confirmDialog()}>
              {dialogBusy ? "Gönderiliyor…" : "Düzeltme iste"}
            </button>
          </>
        }
      >
        <label className="field">
          Gerekçe
          <textarea
            className="input"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby={dialogError ? "duzeltme-hata" : undefined}
          />
        </label>
        {dialogError ? (
          <p id="duzeltme-hata" role="alert" className="mt-2 text-sm text-bad">
            {dialogError}
          </p>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={pending?.type === "activate"}
        title="Kampanya etkinleştirilsin mi?"
        description={
          activation ? (
            <div className="space-y-3">
              <p>
                {activation.dailyBudgetCents != null ? (
                  <>
                    <span className="font-medium text-ink">{activation.title}</span> için günlük{" "}
                    <span className="font-medium text-ink">{formatMoney(activation.dailyBudgetCents, activation.currency)}</span> harcama başlayacak.
                  </>
                ) : (
                  <>
                    <span className="font-medium text-ink">{activation.title}</span> etkinleştirilince harcama, Meta&apos;daki bütçe
                    ayarına göre başlayacak.
                  </>
                )}
              </p>
              {monthlyOfThis != null ? (
                <ul className="list-inside list-disc space-y-1">
                  <li>
                    Bu kampanyanın aylık tahmini {formatMoney(monthlyOfThis, activation.currency)} (günlük bütçe × {monthly.monthDays}).
                  </li>
                  {monthlyTotal != null ? (
                    <li>
                      Etkin kampanyalarla birlikte aylık tahmini {formatMoney(monthlyTotal, monthly.currency)}
                      {monthly.capCents != null
                        ? ` / üst sınır ${formatMoney(monthly.capCents, monthly.currency)}.`
                        : "; aylık üst sınır tanımlı değil."}
                    </li>
                  ) : null}
                </ul>
              ) : null}
              {exceeds ? (
                <p className="rounded-lg border border-bad-line bg-bad-bg p-3 text-bad">
                  Bu toplam aylık üst sınırı aşıyor; etkinleştirme engellenecek. Önce üst sınırı yükseltin ya da etkin bir kampanyayı duraklatın.
                </p>
              ) : null}
            </div>
          ) : undefined
        }
        confirmLabel="Kampanyayı etkinleştir"
        cancelLabel="Vazgeç"
        busy={dialogBusy}
        busyLabel="Etkinleştiriliyor…"
        error={dialogError}
        onConfirm={() => void confirmDialog()}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        open={pending?.type === "dismiss"}
        title="Öneri yok sayılsın mı?"
        description={
          pending?.type === "dismiss" ? (
            <p>
              &quot;{pending.item.title}&quot; kapatılır ve uygulanmaz. Bütçede hiçbir değişiklik yapılmaz.
            </p>
          ) : undefined
        }
        confirmLabel="Yok say"
        cancelLabel="Vazgeç"
        busy={dialogBusy}
        busyLabel="Kaydediliyor…"
        error={dialogError}
        onConfirm={() => void confirmDialog()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
