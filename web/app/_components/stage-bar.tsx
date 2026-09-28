import { Badge } from "./ui";
import { stageSentence, type StageInfo } from "../_lib/stages";

/** Mevcut aşamanın rengi (globals.css ikon tonları). */
const CURRENT: Record<StageInfo["state"], string> = {
  human: "#dc6803",
  progress: "#2e90fa",
  problem: "#c4320a",
  done: "#079455",
  idle: "#98a2b3",
};

/**
 * Mini aşama şeridi (K8-C): N bölüm + durum etiketi + ekran okuyucu cümlesi. Sunucu ve istemci
 * bileşenlerinde kullanılabilir. Bölümler süstür (`aria-hidden`); anlam etikette ve cümlededir.
 */
export function StageBar({ stage, showLabel = true }: { stage: StageInfo; showLabel?: boolean }) {
  const segments = Array.from({ length: stage.total }, (_, i) => {
    if (stage.state === "done") return CURRENT.done;
    if (i < stage.index) return "#475467";
    if (i === stage.index) return CURRENT[stage.state];
    return "#e4e7ec";
  });
  return (
    <span className="relative inline-flex flex-wrap items-center gap-2 align-middle">
      <span aria-hidden="true" className="inline-flex gap-0.5" title={stageSentence(stage)}>
        {segments.map((color, i) => (
          <span key={i} className="block h-1.5 w-3.5 rounded-[3px]" style={{ background: color }} />
        ))}
      </span>
      {showLabel ? (
        <span aria-hidden="true">
          <Badge tone={stage.tone}>{stage.label}</Badge>
        </span>
      ) : null}
      <span className="sr-only">{stageSentence(stage)}</span>
    </span>
  );
}
