"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, IntroPanel, PageHeader, SectionHeading, type Tone } from "../_components/ui";
import { ConfirmDialog, Dialog } from "../_components/dialog";
import { formatDate, formatMoney, formatNumber } from "../_lib/format";
import { countryName, languageName, priorityLabel } from "../_lib/labels";
import { OrgChart } from "./org-chart";

interface Run {
  id: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  simulated: boolean;
  agentsTotal: number;
  agentsCompleted: number;
  agentsFailed: number;
  summary: string | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  finishedAt: string | null;
}
interface Report {
  agentKey: string;
  role: string;
  team: string | null;
  status: string;
  output: { summary?: string; findings?: string[]; risks?: string[]; rejected?: { title: string; reason: string }[] } | null;
}
interface Proposal {
  id: string;
  rank: number;
  title: string;
  market: string | null;
  language: string | null;
  service: string | null;
  angle: string;
  dailyBudgetCents: number | null;
  currency: string;
  priority: string;
  rationale: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  decisionNote: string | null;
}
interface Overview {
  canRun: boolean;
  canDecide: boolean;
  dailyRunLimit: number;
  teamSize: number;
  teams: { key: string; title: string; specialists: { key: string; title: string }[] }[];
  runs: Run[];
  latest: Run | null;
  reports: Report[];
  proposals: Proposal[];
}

const RUN_STATUS: Record<Run["status"], { label: string; tone: Tone }> = {
  RUNNING: { label: "Çalışıyor", tone: "blue" },
  COMPLETED: { label: "Tamamlandı", tone: "green" },
  FAILED: { label: "Tamamlanamadı", tone: "red" },
};
const PROPOSAL_STATUS: Record<Proposal["status"], { label: string; tone: Tone }> = {
  PENDING: { label: "Onay bekliyor", tone: "amber" },
  APPROVED: { label: "Onaylandı", tone: "green" },
  REJECTED: { label: "Reddedildi", tone: "gray" },
};
const MARKET_LABEL: Record<string, string> = {
  TURKEY: "Türkiye",
  GERMANY: "Almanya",
  UK: "Birleşik Krallık",
  NETHERLANDS: "Hollanda",
  USA: "ABD",
  GULF: "Körfez ülkeleri",
  OTHER: "Diğer pazarlar",
};
const POLL_MS = 4000;

/**
 * Lead takımı (ADR-0029): 50 ajanlık hiyerarşi — uzmanlar takım liderine, liderler direktöre rapor verir; nihai
 * kararı direktör verir. Direktörün önerileri burada bir insanın onayını bekler; onay kampanya oluşturmaz.
 */
export default function LeadTeamPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmRun, setConfirmRun] = useState(false);
  const [rejecting, setRejecting] = useState<Proposal | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [rejectError, setRejectError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api<Overview>("/api/lead-team"));
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Lead takımı yüklenemedi. Sayfayı yenileyin.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Çalışma sürerken ilerleme düzenli yenilenir.
  const running = data?.latest?.status === "RUNNING";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  async function run() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/lead-team", "POST", {});
      setNotice("Takım çalışmaya başladı. İlerleme aşağıda görünür.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Takım çalıştırılamadı. Tekrar deneyin.");
    } finally {
      setConfirmRun(false);
      setBusy(false);
      void load();
    }
  }

  async function decide(proposal: Proposal, decision: "APPROVE" | "REJECT", note?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/lead-team/proposals/${proposal.id}`, "POST", { decision, ...(note ? { note } : {}) });
      setNotice(decision === "APPROVE" ? "Öneri onaylandı." : "Öneri reddedildi.");
      setRejecting(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Karar kaydedilemedi. Tekrar deneyin.";
      if (decision === "REJECT") setRejectError(message);
      else setError(message);
    } finally {
      setBusy(false);
      void load();
    }
  }

  if (loadError && !data)
    return (
      <div className="space-y-6">
        <PageHeader title="Lead takımı" crumbs={[{ label: "Performans" }]} />
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {loadError}
        </p>
      </div>
    );
  if (!data)
    return (
      <div className="space-y-6">
        <PageHeader title="Lead takımı" crumbs={[{ label: "Performans" }]} />
        <div role="status" aria-label="Yükleniyor" className="h-64 animate-pulse rounded-xl bg-slate-200/60" />
      </div>
    );

  const latest = data.latest;
  const done = latest ? latest.agentsCompleted + latest.agentsFailed : 0;
  const reportOf = new Map(data.reports.map((r) => [r.agentKey, r]));
  const director = reportOf.get("director");
  const specialistCount = data.teams.reduce((sum, team) => sum + team.specialists.length, 0);
  const pendingProposals = data.proposals.filter((p) => p.status === "PENDING").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lead takımı"
        description={`${data.teamSize} ajan lead üretimi için reklam planı önerir: uzmanlar takım liderine, liderler direktöre rapor verir. Nihai kararı direktör verir; uygulanması sizin onayınıza bağlıdır.`}
        crumbs={[{ label: "Performans" }]}
        actions={
          data.canRun ? (
            <button type="button" className="primary-button" disabled={busy || running} onClick={() => setConfirmRun(true)}>
              {running ? "Takım çalışıyor…" : "Takımı çalıştır"}
            </button>
          ) : null
        }
      />

      <IntroPanel title="Takım ne yapar, ne yapmaz">
        Takım yalnızca reklam kanalını planlar: Meta lead formları, mesaja yönlendiren reklamlar ve kliniğin kendi
        sayfası. Reklam yayınlamaz, bütçe değiştirmez, kimseyle iletişim kurmaz. Onayladığınız öneri kampanyaya
        dönüşmez; kampanyayı <Link className="text-link" href="/campaign-planner">Yeni kampanya</Link> sayfasında
        kendi onay akışıyla kurarsınız.
      </IntroPanel>

      {error && (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </p>
      )}
      <p role="status" className={notice ? "text-sm text-emerald-800" : "sr-only"}>
        {notice}
      </p>

      <section aria-labelledby="hiyerarsi-baslik" className="kc-panel">
        <div className="kc-panel__head">
          <h2 id="hiyerarsi-baslik">Hiyerarşi</h2>
          <p className="kc-panel__meta">
            1 direktör · {data.teams.length} takım lideri · {specialistCount} uzman
          </p>
        </div>
        <OrgChart
          teams={data.teams}
          statusOf={(key) => reportOf.get(key)?.status}
          hasRun={latest !== null}
          pendingProposals={pendingProposals}
        />
      </section>

      <Card>
        <SectionHeading title="Son çalıştırma" description={`24 saatte en fazla ${data.dailyRunLimit} çalıştırma yapılabilir.`} />
        {!latest ? (
          <EmptyState message="Takım henüz çalıştırılmadı." />
        ) : (
          <div className="mt-4 space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={RUN_STATUS[latest.status].tone}>{RUN_STATUS[latest.status].label}</Badge>
              {latest.simulated && <Badge tone="amber">Deneme çıktısı</Badge>}
              <span className="text-muted">
                Başlangıç: <time dateTime={latest.startedAt}>{formatDate(latest.startedAt)}</time>
              </span>
            </div>
            <div>
              <progress className="w-full" max={latest.agentsTotal} value={done} aria-label="Tamamlanan ajan sayısı" />
              <p className="mt-1 text-ink-2">
                {formatNumber(done)} / {formatNumber(latest.agentsTotal)} ajan tamamlandı
                {latest.agentsFailed > 0 ? ` · ${formatNumber(latest.agentsFailed)} ajan rapor üretemedi` : ""}
                {!latest.simulated && latest.inputTokens + latest.outputTokens > 0
                  ? ` · ${formatNumber(latest.inputTokens + latest.outputTokens)} token`
                  : ""}
              </p>
            </div>
            {latest.simulated && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
                Deneme modu: yapay zekâ ayarlı olmadığı için ajan çıktıları kalıpla üretildi. Bunlar analiz sonucu
                değildir; akışı denemek içindir.
              </p>
            )}
            {latest.error && (
              <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800">
                {latest.error}
              </p>
            )}
          </div>
        )}
      </Card>

      {latest?.summary && (
        <Card>
          <SectionHeading title="Direktörün kararı" description="Takımın nihai kararı. Öneriler aşağıda onayınızı bekler." />
          <p className="mt-4 whitespace-pre-line text-sm text-ink">{latest.summary}</p>
          {(director?.output?.rejected ?? []).length > 0 && (
            <div className="mt-4 text-sm">
              <h3 className="font-semibold text-ink">Direktörün elediği öneriler</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
                {director!.output!.rejected!.map((r, i) => (
                  <li key={i}>
                    <span className="font-medium text-ink">{r.title}:</span> {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {data.proposals.length > 0 && (
        <Card>
          <SectionHeading
            title="Öneriler"
            description={
              data.canDecide
                ? "Onay, önerinin uygulanmaya değer bulunduğunu kaydeder; harcama başlatmaz."
                : "Önerileri hesap sahibi ya da yönetici onaylar."
            }
          />
          <ol className="mt-4 space-y-3">
            {data.proposals.map((p) => {
              const status = PROPOSAL_STATUS[p.status];
              return (
                <li key={p.id} className="rounded-lg border border-line p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">
                      {p.rank}. {p.title}
                    </span>
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span className="text-xs text-muted">{priorityLabel(p.priority)}</span>
                  </div>
                  <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    <div className="flex gap-2">
                      <dt className="text-muted">Pazar:</dt>
                      <dd className="text-ink">{p.market ? (MARKET_LABEL[p.market] ?? countryName(p.market)) : "Belirtilmedi"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-muted">Dil:</dt>
                      <dd className="text-ink">{p.language ? languageName(p.language) : "Belirtilmedi"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-muted">Hizmet:</dt>
                      <dd className="text-ink">{p.service ?? "Belirtilmedi"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-muted">Önerilen günlük bütçe:</dt>
                      <dd className="text-ink">{p.dailyBudgetCents != null ? formatMoney(p.dailyBudgetCents, p.currency) : "Belirtilmedi"}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-ink">
                    <span className="font-medium">Mesaj açısı:</span> {p.angle}
                  </p>
                  <p className="mt-1 text-ink-2">
                    <span className="font-medium text-ink">Gerekçe:</span> {p.rationale}
                  </p>
                  {p.decisionNote && <p className="mt-1 text-ink-2">Ret gerekçesi: {p.decisionNote}</p>}
                  {data.canDecide && p.status === "PENDING" && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" className="primary-button" disabled={busy} onClick={() => void decide(p, "APPROVE")}>
                        Onayla
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => {
                          setRejectNote("");
                          setRejectError("");
                          setRejecting(p);
                        }}
                      >
                        Reddet
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </Card>
      )}

      <Card>
        <SectionHeading
          title="Takım raporları"
          description="Her takımın lider özeti ve uzman bulguları son çalıştırmadan gelir."
        />
        <div className="mt-4 space-y-2">
          {data.teams.map((team) => {
            const lead = reportOf.get(`lead:${team.key}`);
            const finished = team.specialists.filter((s) => reportOf.get(s.key)?.status === "COMPLETED").length;
            return (
              <details key={team.key} className="rounded-lg border border-line p-3 text-sm">
                <summary className="cursor-pointer font-medium text-ink">
                  {team.title} takımı · 1 lider, {team.specialists.length} uzman
                  {latest ? ` · ${finished}/${team.specialists.length} uzman raporu` : ""}
                </summary>
                {lead?.output?.summary ? (
                  <p className="mt-3 text-ink">
                    <span className="font-medium">Lider özeti:</span> {lead.output.summary}
                  </p>
                ) : latest ? (
                  <p className="mt-3 text-ink-2">{lead ? "Lider rapor üretemedi." : "Lider raporu henüz yok."}</p>
                ) : null}
                {(lead?.output?.risks ?? []).length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
                    {lead!.output!.risks!.map((risk, i) => (
                      <li key={i}>Risk: {risk}</li>
                    ))}
                  </ul>
                )}
                <ul className="mt-3 space-y-2">
                  {team.specialists.map((s) => {
                    const report = reportOf.get(s.key);
                    return (
                      <li key={s.key}>
                        <span className="font-medium text-ink">{s.title}</span>
                        {report?.status === "FAILED" && <span className="text-ink-2"> · rapor üretemedi</span>}
                        {(report?.output?.findings ?? []).length > 0 && (
                          <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-2">
                            {report!.output!.findings!.map((finding, i) => (
                              <li key={i}>{finding}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </details>
            );
          })}
        </div>
      </Card>

      <ConfirmDialog
        open={confirmRun}
        title="Lead takımı çalıştırılsın mı?"
        description={`${data.teamSize} ajan sırayla çalışır; birkaç dakika sürer ve ${data.teamSize} yapay zekâ çağrısı yapılır. Takım yalnızca öneri üretir; reklam yayınlamaz ve harcama yapmaz.`}
        confirmLabel="Takımı çalıştır"
        busy={busy}
        busyLabel="Başlatılıyor…"
        onConfirm={() => void run()}
        onCancel={() => setConfirmRun(false)}
      />

      <Dialog
        open={rejecting !== null}
        title="Öneriyi reddet"
        description={rejecting ? `"${rejecting.title}" önerisi reddedilecek.` : undefined}
        onClose={() => {
          if (!busy) setRejecting(null);
        }}
        footer={
          <>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setRejecting(null)}>
              Vazgeç
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => {
                if (!rejectNote.trim()) setRejectError("Reddetme gerekçesini yazın.");
                else if (rejecting) void decide(rejecting, "REJECT", rejectNote.trim());
              }}
            >
              {busy ? "Kaydediliyor…" : "Reddet"}
            </button>
          </>
        }
      >
        <label className="field">
          Gerekçe
          <textarea rows={3} maxLength={500} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
        </label>
        {rejectError && (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {rejectError}
          </p>
        )}
      </Dialog>
    </div>
  );
}
