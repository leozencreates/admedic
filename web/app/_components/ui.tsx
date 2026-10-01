import Link from "next/link";
import type { ReactNode } from "react";

export type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";

/** K1-B durum tonları (globals.css belirteçleri): zemin / kenar / metin. `violet` durum için kullanılmaz. */
const TONE_CLASSES: Record<Tone, string> = {
  green: "bg-ok-bg text-ok ring-ok-line",
  amber: "bg-warn-bg text-warn ring-warn-line",
  red: "bg-bad-bg text-bad ring-bad-line",
  blue: "bg-info-bg text-info ring-info-line",
  violet: "bg-brand-50 text-brand-700 ring-brand-200",
  gray: "bg-neutral-bg text-neutral ring-line",
};

export function Badge({ tone = "gray", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex min-h-[22px] items-center whitespace-nowrap rounded-full px-2 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-card border border-line bg-surface p-5 ${className}`}>
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** Kullanılmıyor (eskiden ekran okuyucuya renk adı okutuyordu); geriye dönük uyumluluk için kabul edilir. */
  tone?: Tone;
}) {
  return (
    <Card>
      <p className="text-sm font-medium text-muted">{label}</p>
      <p className="mt-2 font-display text-[26px] font-bold leading-8 tabular-nums text-ink">{value}</p>
      {hint ? <div className="mt-2 text-xs text-muted">{hint}</div> : null}
    </Card>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-bold text-ink">{title}</h2>
        {description ? <p className="text-sm text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-card border border-dashed border-btn-line p-6 text-center text-sm text-muted">
      {message}
    </div>
  );
}

export function Th({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`whitespace-nowrap px-3 py-2 text-xs font-semibold text-muted ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className = "",
}: {
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={`whitespace-nowrap px-3 py-2 text-sm text-slate-700 ${
        align === "right" ? "text-right" : "text-left"
      } ${className}`}
    >
      {children}
    </td>
  );
}

/**
 * Kompakt sayfa başlığı (K6-B, ADR-0017): isteğe bağlı ekmek kırıntısı, h1 (menü adı ya da kayıt adı),
 * tek satırlık açıklama ve sağda en çok bir birincil + bir ikincil eylem. Tanıtım bandı yok;
 * sayfanın ne işe yaradığı yalnızca boş durumda `IntroPanel` ile anlatılır.
 */
export function PageHeader({
  title,
  description,
  crumbs,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Ör. [{ label: "Kampanyalar", href: "/campaigns" }]; son öğe başlığın kendisidir, yazılmaz. */
  crumbs?: { label: string; href?: string }[];
  actions?: ReactNode;
}) {
  // Kayıt sayfası (üst sayfaya bağlantılı kırıntı): telefonda da h1 görünür; diğer sayfalarda sayfa adı
  // telefonda üst çubukta yazdığından h1 yalnızca ekran okuyucuya kalır (çift başlık olmaz).
  const isRecord = crumbs?.some((c) => c.href) ?? false;
  return (
    <header className={isRecord ? "page-header page-header--record" : "page-header"}>
      <div className="min-w-0">
        {crumbs && crumbs.length > 0 ? (
          <nav aria-label="Konum" className="page-header__crumbs">
            {crumbs.map((crumb, i) => (
              <span key={`${crumb.label}-${i}`} className="inline-flex gap-1.5">
                {crumb.href ? <Link href={crumb.href}>{crumb.label}</Link> : <span>{crumb.label}</span>}
                <span aria-hidden="true">›</span>
              </span>
            ))}
          </nav>
        ) : null}
        <h1>{title}</h1>
        {description ? <p className="page-header__desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

/** Boş durumda sayfanın amacını anlatan panel (K6-B): başlık, bir-iki cümle ve isteğe bağlı ilk eylem. */
export function IntroPanel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="intro-panel">
      <h2>{title}</h2>
      <div className="mt-1 max-w-[640px] text-sm text-ink-2">{children}</div>
      {action ? <div className="mt-4 flex flex-wrap gap-2">{action}</div> : null}
    </section>
  );
}
