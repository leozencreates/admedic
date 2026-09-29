import { Badge, type Tone } from "../_components/ui";
import type { Check, CheckStatus } from "../_lib/go-live";

export const STATUS: Record<CheckStatus, { label: string; tone: Tone }> = {
  ok: { label: "Hazır", tone: "green" },
  warn: { label: "Eksik", tone: "amber" },
  fail: { label: "Engel", tone: "red" },
};

/** Denetim satırları: durum metinle de yazılır (yalnızca renkle anlatılmaz). */
export function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul className="divide-y divide-line-soft">
      {checks.map((c) => (
        <li key={c.key} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-4">
          <span className="shrink-0 sm:w-20">
            <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
          </span>
          <div className="min-w-0">
            <p className="font-medium text-ink">{c.label}</p>
            <p className="break-words text-sm text-ink-2">{c.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
