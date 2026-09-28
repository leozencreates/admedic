"use client";
import { Badge, Card, SectionHeading, type Tone } from "../../_components/ui";
import { BTN_SECONDARY, progressText, type CampaignData, type PublishProgress } from "../../_lib/campaign-ui";
import { formatDate } from "../../_lib/format";
import { adEffectiveStatusStyle, metaReviewStyle, publishStepLabel } from "../../_lib/labels";
import type { CampaignAction } from "./types";

const PUBLISH_STATUS: Record<PublishProgress["status"], { label: string; tone: Tone }> = {
  NOT_STARTED: { label: "Henüz yüklenmedi", tone: "gray" },
  IN_PROGRESS: { label: "Yükleme yarım kaldı", tone: "amber" },
  COMPLETE: { label: "Meta'ya yüklendi", tone: "green" },
  EXTERNAL: { label: "Meta'da oluşturuldu", tone: "blue" },
};

/** Meta reklam incelemesi (reklam düzeyi; ADR-0015): durum, sayılar ve reddedilen/sorunlu reklamların gerekçeleri. */
function ReviewBlock({ campaign: c }: { campaign: CampaignData }) {
  const review = c.review;
  if (!review) return <p className="text-sm text-ink-3">Meta incelemesi henüz okunmadı.</p>;
  const style = metaReviewStyle(review.status);
  const counts = [
    review.disapproved ? `${review.disapproved} reddedildi` : "",
    review.withIssues ? `${review.withIssues} sorunlu` : "",
    review.pending ? `${review.pending} incelemede` : "",
  ].filter(Boolean);
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-3">Meta incelemesi:</span>
        <Badge tone={style.tone}>{style.label}</Badge>
        {counts.length > 0 && (
          <span className="text-ink-2">
            {counts.join(" · ")}
            {review.total ? ` (toplam ${review.total} reklam)` : ""}
          </span>
        )}
        {review.checkedAt && <span className="text-ink-3">Son kontrol: {formatDate(review.checkedAt)}</span>}
      </div>
      {review.ads.length > 0 && (
        <ul className="list-inside list-disc text-rose-700">
          {review.ads.map((ad, i) => (
            <li key={`${ad.name}-${i}`}>
              {ad.name || "Adsız reklam"}
              {ad.effectiveStatus ? ` (${adEffectiveStatusStyle(ad.effectiveStatus).label})` : ""}:{" "}
              {ad.reasons.length ? ad.reasons.join("; ") : "Meta gerekçe bildirmedi."}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PublishTab({
  campaign: c,
  progress,
  busy,
  canRefreshReview,
  onRefreshReview,
}: {
  campaign: CampaignData;
  /** Yükleme sürerken canlı ilerleme, değilse sunucudaki durum. */
  progress: PublishProgress;
  busy: CampaignAction | null;
  canRefreshReview: boolean;
  onRefreshReview: () => void;
}) {
  const status = PUBLISH_STATUS[progress.status] ?? PUBLISH_STATUS.NOT_STARTED;
  const lastError = c.workflowStatus === "APPROVED" ? progress.lastError : null;
  const showProgress = progress.status !== "NOT_STARTED" || busy === "publish";
  return (
    <div className="space-y-6">
      <Card>
        <SectionHeading title="Meta'ya yükleme" />
        <div className="space-y-2 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{busy === "publish" ? "Yükleniyor" : status.label}</Badge>
            {showProgress && <span className="text-ink-2">{progressText(progress)}</span>}
          </p>
          {progress.status === "NOT_STARTED" && busy !== "publish" && (
            <p className="text-ink-3">
              Kampanya onaylandıktan sonra Meta&apos;ya kapalı olarak yüklenir; harcama, etkinleştirildiğinde başlar.
            </p>
          )}
          {progress.status === "EXTERNAL" && (
            <p className="text-ink-3">Bu kampanya Meta&apos;da bu panelin yükleme akışı dışında kuruldu.</p>
          )}
          {lastError && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
              Son hata ({publishStepLabel(lastError.step)} adımında{lastError.at ? `, ${formatDate(lastError.at)}` : ""}): {lastError.message}
            </p>
          )}
        </div>
      </Card>
      <Card>
        <SectionHeading
          title="Meta incelemesi"
          action={
            canRefreshReview ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={onRefreshReview}
                title="Reklamların Meta inceleme durumunu ve red gerekçelerini şimdi okur"
                className={BTN_SECONDARY}
              >
                {busy === "review" ? "Yenileniyor…" : "İncelemeyi yenile"}
              </button>
            ) : undefined
          }
        />
        <ReviewBlock campaign={c} />
      </Card>
    </div>
  );
}
