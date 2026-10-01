import Link from "next/link";
import { formatDuration, formatNumber, formatRoas } from "../_lib/format";
import { LEAD_TEAM_HREF } from "../_lib/pending-approvals";
import { campaignHref } from "../_lib/record-refs";
import type { CampaignRow, Kpi, LeadTeamSnapshot, PipelineStage, QueueItem } from "../_lib/today";

/**
 * Bugün ekranının parçaları (ADR-0030 "Kontrol merkezi"): akış bandı ve üç panel. Sunucu bileşenleridir; veriyi
 * `_lib/today.ts` üretir. Renk tek başına anlam taşımaz: her tonun yanında görünür metin ya da ekran okuyucu metni vardır.
 */

/** İşin hangi aşamada kaç kayıtla durduğu; her hücre o aşamanın sayfasına gider. */
export function PipelineBand({ stages }: { stages: PipelineStage[] }) {
  if (!stages.length) return null;
  return (
    <nav aria-label="İş akışı">
      <ol className="kc-band">
        {stages.map((stage) => (
          <li key={stage.key}>
            <Link href={stage.href} className="kc-band__cell" data-tone={stage.tone} data-active={stage.count > 0 ? "true" : "false"}>
              <span className="kc-band__label">{stage.label}</span>
              <span className="kc-band__num">{formatNumber(stage.count)}</span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Sizden beklenenler: ilk iş büyük kartta, diğerleri sıkı satırlarda; satır başına tek eylem. */
export function QueuePanel({ queue, now }: { queue: { items: QueueItem[]; total: number; more: boolean }; now: number }) {
  const countText = `${queue.more ? "en az " : ""}${formatNumber(queue.total)}`;
  return (
    <section aria-labelledby="kuyruk-baslik" className="kc-panel">
      <div className="kc-panel__head">
        <h2 id="kuyruk-baslik">Sizden beklenenler</h2>
        {queue.total > 0 ? (
          <p className="kc-panel__meta">
            {queue.total > queue.items.length || queue.more
              ? `En önemli ${formatNumber(queue.items.length)} iş · ${countText} toplam`
              : `${countText} iş`}
          </p>
        ) : null}
      </div>
      {queue.items.length === 0 ? (
        <p className="text-sm text-ink-2">Şu an sizden beklenen iş yok. Yeni bir iş geldiğinde burada görünür.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {queue.items.map((item, i) => (
            <li key={item.key} className="kc-task" data-tone={item.tone} data-lead={i === 0 ? "true" : "false"}>
              <div className="kc-task__body">
                <p className="kc-task__kind">
                  <span aria-hidden="true" className="kc-dot" data-tone={item.tone} />
                  <span>
                    {item.kind}
                    {item.tone === "problem" ? <span className="sr-only"> (sorun)</span> : null}
                  </span>
                  {item.since ? <span className="kc-task__wait">{formatDuration(now - item.since.getTime())} bekliyor</span> : null}
                </p>
                <p id={`is-${item.key}`} className="kc-task__title">
                  {item.title}
                </p>
                {item.context ? <p className="break-words text-sm text-ink-2">{item.context}</p> : null}
              </div>
              <Link
                href={item.action.href}
                aria-describedby={`is-${item.key}`}
                className={i === 0 || item.tone === "problem" ? "primary-button" : "secondary-button"}
              >
                {item.action.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Temel göstergeler ve (varsa) son 7 günün kampanya getirisi çubukları. */
export function PerformancePanel({ kpis, ranking }: { kpis: Kpi[]; ranking: CampaignRow[] | null }) {
  const top = Math.max(0, ...(ranking ?? []).map((row) => row.roas ?? 0));
  return (
    <section aria-labelledby="gosterge-baslik" className="kc-panel">
      <div className="kc-panel__head">
        <h2 id="gosterge-baslik">Performans</h2>
        <Link href="/insights" className="text-link text-sm">
          İçgörüler
        </Link>
      </div>
      <dl className="kc-kpis">
        {kpis.map((kpi) => (
          <div key={kpi.key} className="kc-kpi">
            <dt>{kpi.label}</dt>
            <dd className="kc-kpi__value" data-warn={kpi.warn ? "true" : "false"}>
              {kpi.value}
              {kpi.warn ? <span className="kc-kpi__flag">Hedefin dışında</span> : null}
            </dd>
            {kpi.hint ? <dd className="kc-kpi__hint">{kpi.hint}</dd> : null}
          </div>
        ))}
      </dl>
      {ranking ? (
        <>
          <div className="kc-divider" />
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-ink">
              Kampanya getirisi, son 7 gün{" "}
              <span className="font-normal text-ink-3">
                (<abbr title="Reklam getirisi" className="no-underline">ROAS</abbr>)
              </span>
            </h3>
            {ranking.length === 0 ? (
              <p className="text-sm text-ink-2">Son 7 günde harcaması olan kampanya yok.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {ranking.map((row) => (
                  <li key={row.id} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <Link href={campaignHref(row.id)} className="min-w-0 break-words text-ink hover:underline">
                        {row.name}
                      </Link>
                      <span className="kc-num shrink-0 font-semibold text-ink">{formatRoas(row.roas)}</span>
                    </div>
                    <div className="kc-bar" aria-hidden="true">
                      <span style={{ width: `${top > 0 ? Math.max(2, ((row.roas ?? 0) / top) * 100) : 0}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

const RUN_STATE: Record<NonNullable<LeadTeamSnapshot["status"]>, string> = {
  RUNNING: "Çalışıyor",
  COMPLETED: "Tamamlandı",
  FAILED: "Tamamlanamadı",
};

/** Lead takımının hiyerarşisi: direktör → yedi takım → sizin onayınız. */
export function LeadTeamPanel({ team }: { team: LeadTeamSnapshot }) {
  const ran = team.status !== null;
  return (
    <section aria-labelledby="takim-baslik" className="kc-panel">
      <div className="kc-panel__head">
        <h2 id="takim-baslik">Lead takımı</h2>
        <p className="kc-panel__meta">
          {ran
            ? `${RUN_STATE[team.status!]} · ${formatNumber(team.agentsDone)}/${formatNumber(team.teamSize)} ajan${team.simulated ? " · deneme çıktısı" : ""}`
            : `${formatNumber(team.teamSize)} ajan · henüz çalıştırılmadı`}
        </p>
      </div>
      <div className="flex flex-col gap-1.5 text-sm">
        <div className="kc-node kc-node--director">
          <span>Direktör</span>
          <span className="kc-node__meta">nihai kararı verir</span>
        </div>
        <ul className="kc-branch" aria-label="Direktöre rapor veren takımlar">
          {team.teams.map((t) => (
            <li key={t.key} className="kc-node">
              <span className="min-w-0 break-words">{t.title}</span>
              <span className="kc-node__meta shrink-0">
                {ran ? `${t.reported}/${t.specialists} rapor` : `1 lider · ${t.specialists} uzman`}
              </span>
            </li>
          ))}
        </ul>
        <div className="kc-node kc-node--human">
          <span>Sizin onayınız</span>
          <span className="kc-node__meta">
            {team.pendingProposals > 0 ? `${formatNumber(team.pendingProposals)} öneri bekliyor` : "bekleyen öneri yok"}
          </span>
        </div>
      </div>
      <Link href={LEAD_TEAM_HREF} className="secondary-button self-start">
        Lead takımını aç
      </Link>
    </section>
  );
}
