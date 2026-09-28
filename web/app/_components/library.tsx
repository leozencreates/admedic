"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../_lib/client-api";
import { rtlFor } from "../_lib/creative-lang";
import { formatDay } from "../_lib/format";
import { languageName, policyRiskStyle, studioStatusStyle } from "../_lib/labels";
import { Badge, IntroPanel, PageHeader } from "./ui";
type Item = {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  content: {
    language: string;
    market: string;
    variants: { headline: string }[];
  };
  policy: { risk: string } | null;
  experiment: { id: string } | null;
};
const STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED", "REJECTED"] as const;
/** `canCreate`: rol yeni reklam taslağı oluşturabilir mi (OWNER, ADMIN, MEDIA_BUYER). */
export function Library({ canCreate = true }: { canCreate?: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  async function load() {
    setLoading(true);
    setError(null);
    try {
      setItems((await api<{ drafts: Item[] }>("/api/studio")).drafts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const filtered = items.filter(
    (d) =>
      (!status || d.status === status) &&
      d.name.toLocaleLowerCase("tr").includes(query.toLocaleLowerCase("tr")),
  );
  // Hiç taslak yokken sayaçlar ve süzgeçler gizlenir; yalnızca tanıtım paneli görünür.
  const empty = !loading && error === null && items.length === 0;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Reklam kütüphanesi"
        crumbs={[{ label: "Reklamlar" }]}
        description="Taslakları düzenleyin, içerik kontrollerini inceleyin ve ekibinizle onaylayın."
        actions={
          canCreate ? (
            <Link href="/studio" className="primary-button">
              Reklam oluştur
            </Link>
          ) : undefined
        }
      />
      {empty ? null : (
        <>
          <div className="grid grid-cols-3 gap-3">
            {[
              ["Toplam taslak", items.length],
              [
                "Onay bekleyen",
                items.filter((x) => x.status === "IN_REVIEW").length,
              ],
              ["Onaylanan", items.filter((x) => x.status === "APPROVED").length],
            ].map(([label, value]) => (
              <div className="studio-card" key={label}>
                <p className="section-kicker">{label}</p>
                <strong className="text-3xl">{loading || error !== null ? "—" : value}</strong>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="field min-w-[200px] flex-1">
              Reklam ara
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Klinik veya hizmet adı…"
              />
            </label>
            <label className="field">
              Durum
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Tüm durumlar</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {studioStatusStyle(s).label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}
      {loading ? (
        <div className="studio-card animate-pulse" role="status">
          Kütüphane yükleniyor…
        </div>
      ) : error !== null ? (
        <div className="studio-card" role="alert">
          <p className="font-medium text-rose-800">
            Reklam kütüphanesi yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.
          </p>
          {error && <p className="mt-1 text-sm text-slate-700">{error}</p>}
          <button className="secondary-button mt-4" onClick={load}>
            Tekrar dene
          </button>
        </div>
      ) : items.length === 0 ? (
        <IntroPanel
          title="Henüz reklam taslağı yok"
          action={
            canCreate ? (
              <Link href="/studio" className="primary-button">
                Reklam oluştur
              </Link>
            ) : undefined
          }
        >
          Reklam oluştur sayfasında hazırlanıp kaydedilen taslaklar, içerik kontrolü sonuçları ve onay durumlarıyla
          burada listelenir. Onaylanan taslaktan A/B deneyi oluşturabilirsiniz.
        </IntroPanel>
      ) : filtered.length === 0 ? (
        <div className="studio-card space-y-2 py-8 text-center">
          <p className="text-sm text-ink-2">Süzgeçle eşleşen reklam yok.</p>
          <button
            type="button"
            className="text-link text-sm"
            onClick={() => {
              setQuery("");
              setStatus("");
            }}
          >
            Süzgeçleri temizle
          </button>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => {
            const itemStatus = studioStatusStyle(item.status);
            // İçerik kontrolü hiç yapılmamışsa "İçerik kontrolü yapılmadı" (temiz görünmesin).
            const risk = policyRiskStyle(item.policy?.risk ?? null);
            return (
              <article className="studio-card space-y-4" key={item.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge tone={itemStatus.tone}>{itemStatus.label}</Badge>
                  <span className="text-xs text-muted">
                    {languageName(item.content.language)} · {item.content.market}
                  </span>
                </div>
                <h2>{item.name}</h2>
                <p
                  className="text-sm text-muted"
                  dir={rtlFor(item.content.language)}
                  lang={item.content.language.toLowerCase()}
                >
                  {item.content.variants[0]?.headline}
                </p>
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 text-xs text-muted">
                  <Badge tone={risk.tone}>{risk.label}</Badge>
                  <span>Güncellendi: {formatDay(item.updatedAt)}</span>
                </div>
                <div className="flex gap-3">
                  <Link href={`/studio?id=${item.id}`} className="primary-button">
                    İncele<span className="sr-only">: {item.name}</span>
                  </Link>
                  {item.experiment && (
                    <Link
                      href={`/tests/${item.experiment.id}`}
                      className="secondary-button"
                    >
                      Deneyi aç<span className="sr-only">: {item.name}</span>
                    </Link>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {empty ? null : (
        <p className="text-xs text-muted">Son güncellenen en fazla 100 taslak gösterilir.</p>
      )}
    </div>
  );
}
