import Link from "next/link";
import { connection } from "next/server";
import { Plus } from "lucide-react";

import { EmptyState, IntroPanel, PageHeader, Td, Th } from "../_components/ui";
import { StageBar } from "../_components/stage-bar";
import { EDIT_ROLES, requirePageActor } from "../_lib/auth";
import { EMPTY_METRICS, campaignMetrics, cpl, roas, sinceDays, type Metrics } from "../_lib/campaign-metrics";
import { loadCampaignViews, type CampaignView } from "../_lib/campaign-view";
import { formatMoney, formatNumber, formatRoas } from "../_lib/format";
import { campaignHref } from "../_lib/record-refs";
import { campaignStage, isExternalCampaign, type StageInfo } from "../_lib/stages";

/**
 * Kampanyalar (ADR-0020 · K5-C): tek kampanya listesi. Her satır aşama şeridi ve son 7 günün harcaması, lead
 * sayısı, lead başı maliyeti ve reklam getirisiyle kampanya sayfasına (`/campaigns/<id>`) götürür.
 * Önce bir insandan eylem bekleyenler, sonra son 7 günde en çok harcayanlar. Yeni kampanya planlayıcıda oluşturulur.
 */
type Filter = "all" | "action" | "live" | "archived";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Tümü" },
  { key: "action", label: "Eylem bekleyen" },
  { key: "live", label: "Yayında" },
  { key: "archived", label: "Arşiv" },
];

interface Row {
  c: CampaignView;
  stage: StageInfo;
  m: Metrics;
}

function stageOf(c: CampaignView): StageInfo {
  return campaignStage(c.workflowStatus, {
    publishIncomplete: c.workflowStatus === "APPROVED" && c.publish.status === "IN_PROGRESS",
    metaPaused: c.workflowStatus === "ACTIVE" && c.status === "PAUSED",
    external: isExternalCampaign(c),
    metaStatus: c.status,
  });
}

function matches(row: Row, filter: Filter): boolean {
  if (filter === "all") return row.c.workflowStatus !== "ARCHIVED";
  if (filter === "archived") return row.c.workflowStatus === "ARCHIVED";
  if (filter === "action") return row.stage.state === "human" || row.stage.state === "problem";
  return row.stage.state === "done";
}

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  await connection();
  const actor = await requirePageActor("/campaigns");
  const requested = (await searchParams).filter;
  const filter: Filter = FILTERS.some((f) => f.key === requested) ? (requested as Filter) : "all";
  const [campaigns, week] = await Promise.all([loadCampaignViews(actor), campaignMetrics(actor.workspaceId, sinceDays(7))]);
  const rows: Row[] = campaigns.map((c) => ({ c, stage: stageOf(c), m: week.get(c.id) ?? EMPTY_METRICS }));
  const urgent = (r: Row) => (r.stage.state === "problem" ? 0 : r.stage.state === "human" ? 1 : 2);
  rows.sort((a, b) => urgent(a) - urgent(b) || b.m.spend - a.m.spend || a.c.name.localeCompare(b.c.name, "tr"));
  const visible = rows.filter((r) => matches(r, filter));
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, rows.filter((r) => matches(r, f.key)).length])) as Record<Filter, number>;
  const canCreate = EDIT_ROLES.includes(actor.role);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Kampanyalar"
        description="Her kampanyanın akıştaki yeri ve son 7 günün sonuçları; ayrıntı ve işlemler kampanya sayfasında."
        actions={
          canCreate ? (
            <Link href="/campaign-planner" className="primary-button">
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
              Yeni kampanya
            </Link>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <IntroPanel
          title="Henüz kampanya yok"
          action={
            canCreate ? (
              <Link href="/campaign-planner" className="primary-button">
                Yeni kampanya
              </Link>
            ) : undefined
          }
        >
          Planlayıcı hedefinize göre pazar, dil ve bütçe önerir. Kampanya onaydan geçer, Meta&apos;ya kapalı yüklenir ve
          harcamayı yalnızca harcama yetkisi olan kişi başlatır.
        </IntroPanel>
      ) : (
        <section aria-labelledby="kampanya-listesi" className="studio-card !p-0">
          <h2 id="kampanya-listesi" className="sr-only">
            Kampanya listesi
          </h2>
          <nav aria-label="Kampanyaları süz" className="flex flex-wrap gap-2 border-b border-line p-3">
            {FILTERS.map((f) => {
              const selected = f.key === filter;
              return (
                <Link
                  key={f.key}
                  href={f.key === "all" ? "/campaigns" : `/campaigns?filter=${f.key}`}
                  aria-current={selected ? "page" : undefined}
                  className={`inline-flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium max-sm:min-h-11 ${
                    selected ? "border-brand-200 bg-brand-50 text-brand-700" : "border-btn-line bg-surface text-neutral hover:bg-subtle"
                  }`}
                >
                  {f.label}
                  <span className={`tabular-nums ${f.key === "action" && counts.action > 0 ? "rounded-full bg-warn-badge px-1.5 text-warn" : "text-ink-3"}`}>
                    {counts[f.key]}
                  </span>
                </Link>
              );
            })}
          </nav>

          {visible.length === 0 ? (
            <div className="p-4">
              <EmptyState message="Bu süzgeçte kampanya yok." />
            </div>
          ) : (
            <>
              {/* Masaüstü: tablo */}
              <div className="overflow-x-auto max-md:hidden" tabIndex={0} role="region" aria-label="Kampanyalar tablosu">
                <table className="w-full min-w-[860px]">
                  <thead className="bg-subtle">
                    <tr>
                      <Th>Kampanya</Th>
                      <Th align="right">Günlük bütçe</Th>
                      <Th align="right">Harcama (7 gün)</Th>
                      <Th align="right">Lead</Th>
                      <Th align="right">Lead başı maliyet</Th>
                      <Th align="right">Reklam getirisi (ROAS)</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {visible.map(({ c, stage, m }) => {
                      const currency = c.currency || "EUR";
                      const unit = cpl(m);
                      return (
                        <tr key={c.id} className="hover:bg-subtle">
                          <td className="px-3 py-3 align-top">
                            <Link href={campaignHref(c.id)} className="font-medium text-ink hover:underline">
                              {c.name}
                            </Link>
                            <div className="mt-1">
                              <StageBar stage={stage} />
                            </div>
                          </td>
                          <Td align="right">{formatMoney(c.dailyBudget, currency)}</Td>
                          <Td align="right">{formatMoney(m.spend, currency)}</Td>
                          <Td align="right">{formatNumber(m.leads)}</Td>
                          <Td align="right">{unit != null ? formatMoney(unit, currency, { precise: true }) : "—"}</Td>
                          <Td align="right">{formatRoas(roas(m))}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Telefon: kartlar (kartın tamamı bağlantı) */}
              <ul className="divide-y divide-line-soft md:hidden">
                {visible.map(({ c, stage, m }) => {
                  const currency = c.currency || "EUR";
                  const unit = cpl(m);
                  return (
                    <li key={c.id}>
                      <Link href={campaignHref(c.id)} className="block min-h-[72px] px-4 py-3 hover:bg-subtle">
                        <span className="block font-medium text-ink">{c.name}</span>
                        <span className="mt-1 block">
                          <StageBar stage={stage} />
                        </span>
                        <span className="mt-1.5 block text-xs text-ink-2">
                          7 gün: {formatMoney(m.spend, currency)} · {formatNumber(m.leads)} lead
                          {unit != null ? ` · lead başı ${formatMoney(unit, currency, { precise: true })}` : ""}
                          {" · "}ROAS {formatRoas(roas(m))}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
