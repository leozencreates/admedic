import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { loadEnv } from "@admedic/config";
import { CircleCheck, Circle } from "lucide-react";

import { IntroPanel, PageHeader, Td, Th } from "./_components/ui";
import { requirePageActor } from "./_lib/auth";
import { formatDuration, formatMoney, formatNumber, formatRoas } from "./_lib/format";
import { t } from "./_lib/i18n";
import { uiLanguage } from "./_lib/page-meta";
import { campaignHref } from "./_lib/record-refs";
import { campaignExtremes, setupSteps, todayKpis, todayQueue, type CampaignRow, type QueueItem } from "./_lib/today";

/** Kök sayfa kök layout ile aynı segmentte olduğundan şablon uygulanmaz; başlık tam yazılır. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: { absolute: `${t("nav.overview", await uiLanguage())} · ${loadEnv().APP_NAME}` } };
}

/**
 * Bugün (ADR-0018 · K3-A): rolünüze göre sizden beklenen işler (satır başına tek eylem), temel göstergeler
 * ve kurulum tamamlanana kadar kurulum rehberi. Analist ve izleyici için en iyi / en zayıf kampanyalar.
 */
export default async function TodayPage() {
  await connection();
  const actor = await requirePageActor("/");
  const manager = actor.role === "OWNER" || actor.role === "ADMIN";
  const readOnly = actor.role === "ANALYST" || actor.role === "VIEWER";
  const [queue, kpis, setup, extremes] = await Promise.all([
    readOnly ? Promise.resolve({ items: [] as QueueItem[], total: 0 }) : todayQueue(actor),
    actor.role === "PATIENT_COORDINATOR" ? Promise.resolve([]) : todayKpis(actor),
    manager ? setupSteps(actor) : Promise.resolve([]),
    readOnly ? campaignExtremes(actor) : Promise.resolve(null),
  ]);
  const setupDone = setup.filter((s) => s.done).length;
  const showSetup = setup.length > 0 && setupDone < setup.length;
  const now = Date.now();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bugün"
        description={
          readOnly
            ? "Son 7 günün temel göstergeleri ve kampanyaların durumu."
            : queue.total > 0
              ? `Sizden beklenen ${formatNumber(queue.total)} iş var; önce sorunlar, sonra en uzun bekleyenler.`
              : "Sizden beklenen iş yok. Temel göstergeler aşağıda."
        }
      />

      {showSetup ? (
        <section aria-labelledby="kurulum-baslik" className="studio-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="kurulum-baslik">Kurulum</h2>
            <p className="text-sm text-ink-3">
              {setupDone}/{setup.length} adım tamamlandı
            </p>
          </div>
          <div aria-hidden="true" className="mt-3 flex h-2 overflow-hidden rounded-full bg-line-soft">
            <span className="bg-brand-600" style={{ width: `${(setupDone / setup.length) * 100}%` }} />
          </div>
          <ol className="mt-3 divide-y divide-line-soft">
            {setup.map((step) => (
              <li key={step.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  {step.done ? (
                    <CircleCheck size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[#079455]" aria-hidden="true" />
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
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        {readOnly && extremes ? (
          <Extremes best={extremes.best} worst={extremes.worst} />
        ) : (
          <section aria-labelledby="kuyruk-baslik" className="studio-card min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="kuyruk-baslik">Sizden beklenenler</h2>
              {queue.total > queue.items.length ? (
                <p className="text-sm text-ink-3">
                  En önemli {formatNumber(queue.items.length)} iş gösteriliyor ({formatNumber(queue.total)} toplam)
                </p>
              ) : null}
            </div>
            {queue.items.length === 0 ? (
              <p className="mt-3 text-sm text-ink-2">Şu an sizden beklenen iş yok. Yeni bir iş geldiğinde burada görünür.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line-soft">
                {queue.items.map((item) => (
                  <li key={item.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="flex min-w-0 gap-3">
                      <span
                        aria-hidden="true"
                        className={`mt-1.5 size-2.5 shrink-0 rounded-full ${item.tone === "problem" ? "bg-bad-fill" : "bg-[#dc6803]"}`}
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-ink-3">
                          {item.kind}
                          {item.tone === "problem" ? <span className="sr-only"> (sorun)</span> : null}
                        </p>
                        <p id={`is-${item.key}`} className="break-words font-medium text-ink">
                          {item.title}
                        </p>
                        {item.context ? <p className="break-words text-sm text-ink-2">{item.context}</p> : null}
                        {item.since ? (
                          <p className="text-xs text-ink-3">{formatDuration(now - item.since.getTime())} bekliyor</p>
                        ) : null}
                      </div>
                    </div>
                    <Link
                      href={item.action.href}
                      aria-describedby={`is-${item.key}`}
                      className={`${item.tone === "problem" ? "primary-button" : "secondary-button"} shrink-0 self-start sm:self-auto`}
                    >
                      {item.action.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {kpis.length > 0 ? (
          <section aria-labelledby="gosterge-baslik" className="studio-card self-start !p-0">
            <h2 id="gosterge-baslik" className="border-b border-line px-4 py-3">
              Temel göstergeler
            </h2>
            <dl>
              {kpis.map((kpi, i) => (
                <div key={kpi.key} className={`px-4 py-3 ${i < kpis.length - 1 ? "border-b border-line-soft" : ""}`}>
                  <dt className="text-xs font-medium text-ink-2">{kpi.label}</dt>
                  <dd className={`mt-0.5 text-xl font-semibold tabular-nums ${kpi.warn ? "text-warn" : "text-ink"}`}>
                    {kpi.value}
                    {kpi.warn ? <span className="ml-2 align-middle text-xs font-medium">Hedefin dışında</span> : null}
                  </dd>
                  {kpi.hint ? <dd className="mt-0.5 text-xs text-ink-3">{kpi.hint}</dd> : null}
                </div>
              ))}
            </dl>
            <div className="border-t border-line px-4 py-3">
              <Link href="/insights" className="text-link text-sm">
                İçgörüler
              </Link>
            </div>
          </section>
        ) : null}
      </div>
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
      <table className="w-full min-w-[480px]">
        <caption className="mb-2 text-left text-sm font-medium text-ink">{caption}</caption>
        <thead className="bg-subtle">
          <tr>
            <Th>Kampanya</Th>
            <Th align="right">Harcama</Th>
            <Th align="right">Lead</Th>
            <Th align="right">Reklam getirisi (ROAS)</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {rows.map((r) => (
            <tr key={r.id}>
              <Td>
                <Link href={campaignHref(r.id)} className="font-medium text-ink hover:underline">
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
    <section aria-labelledby="kampanya-ozet" className="studio-card min-w-0 space-y-6">
      <h2 id="kampanya-ozet">Kampanyalar, son 7 gün</h2>
      {table(best, "En yüksek reklam getirisi")}
      {worst.length ? table(worst, "En düşük reklam getirisi") : null}
    </section>
  );
}
