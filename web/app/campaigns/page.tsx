import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { connection } from "next/server";

import { Badge, Card, PageHeader, SectionHeading, Td, Th } from "../_components/ui";
import { daysAgoUTC, getPrimaryWorkspace, prisma } from "../_lib/db";
import { formatMoney, formatNumber, formatRoas } from "../_lib/format";
import { entityStatusStyle } from "../_lib/labels";
import { campaignStage } from "../_lib/stages";
import { StageBar } from "../_components/stage-bar";

const LINK_CLASS =
  "underline decoration-slate-300 underline-offset-2 hover:text-violet-700 hover:decoration-violet-600";

/** Kampanyanın onay/yayın işlemlerinin yapıldığı satır (planlayıcı `?focus=` ile satırı vurgular). */
function plannerHref(campaignId: string) {
  return `/campaign-planner?focus=${encodeURIComponent(campaignId)}`;
}

function Skeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="h-64 animate-pulse rounded-xl bg-slate-200/60" />;
}

/** Yatay kayan tablo: klavyeyle odaklanıp ok tuşlarıyla kaydırılır, ekran okuyucuya adıyla duyurulur. */
function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={label}>
      {children}
    </div>
  );
}

/** Boş durum: ne olduğunu ve sıradaki adımı söyler. */
function EmptyWithAction({ message, href, action }: { message: string; href: string; action: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-muted">
      {message}{" "}
      <Link href={href} className="font-medium text-violet-700 underline-offset-2 hover:underline">
        {action}
      </Link>
    </div>
  );
}

async function Campaigns() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) return <EmptyWithAction message="Çalışma alanı bulunamadı." href="/" action="Bugün sayfasına dönün." />;

  const since = daysAgoUTC(6);
  const [campaigns, grouped, policy] = await Promise.all([
    prisma.campaign.findMany({
      where: { workspaceId: workspace.id },
      include: {
        adAccount: { select: { name: true, currency: true } },
        _count: { select: { adsets: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.insightSnapshot.groupBy({
      by: ["campaignId"],
      where: { workspaceId: workspace.id, date: { gte: since }, campaignId: { not: null } },
      _sum: { spend: true, conversionValue: true, purchases: true },
    }),
    prisma.optimizationPolicy.findUnique({ where: { workspaceId: workspace.id } }),
  ]);

  const byCampaign = new Map(grouped.map((g) => [g.campaignId, g._sum]));
  const targetRoas = policy?.targetRoas ?? null;

  return (
    <Card>
      <SectionHeading
        title="Kampanyalar"
        description="Son 7 günün harcaması, cirosu ve reklam getirisi (ROAS). Kampanya adı, onay ve yayın işlemlerinin yapıldığı Kampanya planlayıcı satırını açar."
      />
      {campaigns.length === 0 ? (
        <EmptyWithAction
          message="Henüz kampanya yok."
          href="/campaign-planner"
          action="Kampanya planlayıcı'da ilk kampanyanızı oluşturun."
        />
      ) : (
        <ScrollRegion label="Kampanyalar tablosu">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Kampanya</Th>
                <Th>Hesap</Th>
                <Th>Durum</Th>
                <Th align="right">Günlük bütçe</Th>
                <Th align="right">Reklam seti</Th>
                <Th align="right">Son 7 gün harcama</Th>
                <Th align="right">Son 7 gün ciro</Th>
                <Th align="right">Satın alma</Th>
                <Th align="right">ROAS</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {campaigns.map((c) => {
                const sum = byCampaign.get(c.id);
                const spend = sum?.spend ?? 0;
                const revenue = sum?.conversionValue ?? 0;
                const roas = spend > 0 ? revenue / spend : null;
                // Meta'ya hiç yüklenmemiş kampanyanın Meta durumu yoktur; onay akışındaki yeri gösterilir.
                // Yüklenmemiş kampanyada aşama şeridi (K8-C) iş akışı etiketini kendisi çizer.
                const status = c.metaCampaignId ? entityStatusStyle(c.status) : null;
                // Tüm tutarlar minor unit; para birimi reklam hesabından (ADR-0011).
                const currency = c.adAccount.currency || "EUR";
                return (
                  <tr key={c.id}>
                    <Td className="font-medium text-slate-900">
                      <Link href={plannerHref(c.id)} className={LINK_CLASS}>
                        {c.name}
                      </Link>
                    </Td>
                    <Td className="text-muted">
                      {c.adAccount.name} · {currency}
                    </Td>
                    <Td className="relative">
                      {status ? <Badge tone={status.tone}>{status.label}</Badge> : <StageBar stage={campaignStage(c.workflowStatus)} />}
                    </Td>
                    <Td align="right">{formatMoney(c.dailyBudget, currency)}</Td>
                    <Td align="right">{formatNumber(c._count.adsets)}</Td>
                    <Td align="right">{formatMoney(spend, currency)}</Td>
                    <Td align="right">{formatMoney(revenue, currency)}</Td>
                    <Td align="right">{formatNumber(sum?.purchases ?? 0)}</Td>
                    <Td align="right">
                      <span
                        className={
                          roas != null && targetRoas != null && roas >= targetRoas
                            ? "font-semibold text-emerald-700"
                            : "font-semibold text-slate-700"
                        }
                      >
                        {formatRoas(roas)}
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </Card>
  );
}

async function AdSets() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) return null;

  const adsets = await prisma.adSet.findMany({
    where: { workspaceId: workspace.id },
    include: {
      campaign: { select: { id: true, name: true, adAccount: { select: { currency: true } } } },
      _count: { select: { ads: true } },
    },
    orderBy: [{ campaignId: "asc" }, { name: "asc" }],
  });

  return (
    <Card>
      <SectionHeading title="Reklam setleri" description="Bütçe ve durum; optimizasyonun en küçük birimi." />
      {adsets.length === 0 ? (
        <EmptyWithAction
          message="Henüz reklam seti yok. Reklam setleri, Kampanya planlayıcı'da kampanya oluşturulduğunda burada listelenir."
          href="/campaign-planner"
          action="Kampanya planlayıcı'yı açın."
        />
      ) : (
        <ScrollRegion label="Reklam setleri tablosu">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Reklam seti</Th>
                <Th>Kampanya</Th>
                <Th>Durum</Th>
                <Th align="right">Günlük bütçe</Th>
                <Th align="right">Reklam</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {adsets.map((a) => {
                // Meta'ya yüklenmemiş reklam seti taslaktır (yerel PAUSED değeri "Duraklatıldı" diye okunmasın).
                const status = entityStatusStyle(a.metaAdSetId ? a.status : "DRAFT");
                return (
                  <tr key={a.id}>
                    <Td className="font-medium text-slate-900">{a.name}</Td>
                    <Td className="text-muted">
                      <Link href={plannerHref(a.campaign.id)} className={LINK_CLASS}>
                        {a.campaign.name}
                      </Link>
                    </Td>
                    <Td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </Td>
                    <Td align="right">{formatMoney(a.dailyBudget, a.campaign.adAccount.currency || "EUR")}</Td>
                    <Td align="right">{formatNumber(a._count.ads)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </Card>
  );
}

export default function Page() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Kampanyalar"
        description="Kampanya ve reklam seti envanteri; onay, Meta'ya yükleme ve yayına alma Kampanya planlayıcı'da yapılır."
        actions={
          <Link href="/campaign-planner" className="primary-button">
            Kampanya planla
          </Link>
        }
      />
      <Suspense fallback={<Skeleton label="Kampanyalar yükleniyor" />}>
        <Campaigns />
      </Suspense>
      <Suspense fallback={<Skeleton label="Reklam setleri yükleniyor" />}>
        <AdSets />
      </Suspense>
    </div>
  );
}
