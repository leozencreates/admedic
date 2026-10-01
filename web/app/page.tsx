import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { loadEnv } from "@admedic/config";
import { CircleCheck, Circle } from "lucide-react";

import { LeadTeamPanel, PerformancePanel, PipelineBand, QueuePanel } from "./_components/today-board";
import { IntroPanel, PageHeader, Td, Th } from "./_components/ui";
import { requirePageActor } from "./_lib/auth";
import { formatMoney, formatNumber, formatRoas } from "./_lib/format";
import { t } from "./_lib/i18n";
import { uiLanguage } from "./_lib/page-meta";
import { campaignHref } from "./_lib/record-refs";
import {
  campaignExtremes,
  campaignRanking,
  setupSteps,
  todayKpis,
  todayLeadTeam,
  todayPipeline,
  todayQueue,
  type CampaignRow,
  type QueueItem,
} from "./_lib/today";

/** Kök sayfa kök layout ile aynı segmentte olduğundan şablon uygulanmaz; başlık tam yazılır. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: { absolute: `${t("nav.overview", await uiLanguage())} · ${loadEnv().APP_NAME}` } };
}

/**
 * Bugün (ADR-0018 · K3-A, görünüm ADR-0030): üstte işin hangi aşamada durduğunu gösteren akış bandı; altında
 * rolünüze göre sizden beklenen işler, performans ve lead takımı. Kurulum tamamlanana kadar kurulum rehberi.
 * Analist ve izleyici için kuyruk yerine en iyi / en zayıf kampanyalar.
 */
export default async function TodayPage() {
  await connection();
  const actor = await requirePageActor("/");
  const manager = actor.role === "OWNER" || actor.role === "ADMIN";
  const readOnly = actor.role === "ANALYST" || actor.role === "VIEWER";
  const [queue, kpis, setup, extremes, pipeline, ranking, team] = await Promise.all([
    readOnly ? Promise.resolve({ items: [] as QueueItem[], total: 0, more: false }) : todayQueue(actor),
    actor.role === "PATIENT_COORDINATOR" ? Promise.resolve([]) : todayKpis(actor),
    manager ? setupSteps(actor) : Promise.resolve([]),
    readOnly ? campaignExtremes(actor) : Promise.resolve(null),
    todayPipeline(actor),
    // Salt okuyan rollerde en iyi / en zayıf tablosu zaten var; çubuklar aynı veriyi tekrar etmesin.
    readOnly || actor.role === "PATIENT_COORDINATOR" ? Promise.resolve(null) : campaignRanking(actor),
    todayLeadTeam(actor),
  ]);
  const setupDone = setup.filter((s) => s.done).length;
  const showSetup = setup.length > 0 && setupDone < setup.length;
  // İlk ekranda önce iş görünür (telefonda kurulum kartı ekranı kaplamasın); bekleyen iş yoksa kurulum üstte.
  const setupFirst = queue.items.length === 0;
  const countText = `${queue.more ? "en az " : ""}${formatNumber(queue.total)}`;
  const now = Date.now();

  const setupCard = (
    <section aria-labelledby="kurulum-baslik" className="kc-panel">
      <div className="kc-panel__head">
        <h2 id="kurulum-baslik">Kurulum</h2>
        <p className="kc-panel__meta">
          {setupDone}/{setup.length} adım tamamlandı
        </p>
      </div>
      <div aria-hidden="true" className="kc-bar">
        <span style={{ width: `${(setupDone / setup.length) * 100}%` }} />
      </div>
      <ol className="divide-y divide-line">
        {setup.map((step) => (
          <li key={step.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 gap-3">
              {step.done ? (
                <CircleCheck size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
              ) : (
                <Circle size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
              )}
              <div className="min-w-0">
                <p className={step.done ? "text-ink-2 line-through decoration-ink-3" : "font-medium text-ink"}>
                  {step.label}
                  <span className="sr-only">{step.done ? " (tamamlandı)" : " (yapılacak)"}</span>
                </p>
                {!step.done ? <p className="text-sm text-ink-2">{step.hint}</p> : null}
              </div>
            </div>
            {!step.done ? (
              <Link href={step.href} className="secondary-button self-start sm:self-auto">
                Başla<span className="sr-only">: {step.label}</span>
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Bugün"
        description={
          readOnly
            ? "Son 7 günün temel göstergeleri ve kampanyaların durumu."
            : queue.total > 0
              ? `Sizden beklenen ${countText} iş var; önce sorunlar, sonra en uzun bekleyenler.`
              : "Sizden beklenen iş yok. İşin hangi aşamada durduğu aşağıda."
        }
      />

      <PipelineBand stages={pipeline} />

      {showSetup && setupFirst ? setupCard : null}

      <div className="kc-cols">
        {readOnly && extremes ? <Extremes best={extremes.best} worst={extremes.worst} /> : <QueuePanel queue={queue} now={now} />}
        {kpis.length > 0 ? <PerformancePanel kpis={kpis} ranking={ranking} /> : null}
        {team ? <LeadTeamPanel team={team} /> : null}
      </div>

      {showSetup && !setupFirst ? setupCard : null}
    </div>
  );
}

function Extremes({ best, worst }: { best: CampaignRow[]; worst: CampaignRow[] }) {
  if (!best.length)
    return (
      <IntroPanel title="Henüz kampanya sonucu yok">
        Kampanyalar Meta'da harcama yapmaya başladığında son 7 günün en yüksek ve en düşük reklam getirisi burada
        karşılaştırılır.
      </IntroPanel>
    );
  const table = (rows: CampaignRow[], caption: string) => (
    <div className="overflow-x-auto">
      <table className="w-full">
        <caption className="mb-2 text-left text-sm font-medium text-ink">{caption}</caption>
        <thead className="bg-subtle">
          <tr>
            <Th>Kampanya</Th>
            <Th align="right">Harcama</Th>
            <Th align="right">Lead</Th>
            <Th align="right">
              <abbr title="Reklam getirisi" className="no-underline">ROAS</abbr>
            </Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {rows.map((r) => (
            <tr key={r.id}>
              <Td>
                <Link href={campaignHref(r.id)} className="break-words font-medium text-ink hover:underline">
                  {r.name}
                </Link>
              </Td>
              <Td align="right">{formatMoney(r.spend, r.currency)}</Td>
              <Td align="right">{formatNumber(r.leads)}</Td>
              <Td align="right">{formatRoas(r.roas)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <section aria-labelledby="kampanya-ozet" className="kc-panel">
      <div className="kc-panel__head">
        <h2 id="kampanya-ozet">Kampanyalar, son 7 gün</h2>
      </div>
      {table(best, "En yüksek reklam getirisi")}
      {worst.length ? table(worst, "En düşük reklam getirisi") : null}
    </section>
  );
}
