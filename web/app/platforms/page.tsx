"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { api } from "../_lib/client-api";
import { formatDate } from "../_lib/format";
import { entityStatusStyle } from "../_lib/labels";
import { Badge, Card, EmptyState, PageHeader, SectionHeading } from "../_components/ui";
interface Platform { id: string; name: string; status: string; syncedAt: string | null; metaAccountId: string | null }
export default function PlatformsPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  // Yükleme hatası boş liste gibi gösterilmez (İÇ-3): "yüklenemedi + Tekrar dene".
  const [loadError, setLoadError] = useState<string | null>(null);
  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<{ platforms: Platform[] }>("/api/platforms");
      setPlatforms(data.platforms ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "");
    }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-8">
      <PageHeader
        title="Platformlar"
        description={
          <>
            Reklam hesaplarınızı ve durumlarını görün; Meta hesaplarını{" "}
            <Link href="/meta-connections" className="text-link">Meta bağlantıları</Link> sayfasından bağlayın.
          </>
        }
        crumbs={[{ label: "Ayarlar" }]}
      />
      <Card>
        <SectionHeading
          title="Reklam hesapları"
          description="Bağlı reklam hesapları. Meta bağlantısı kesilen ya da duraklatılan hesaplar “Duraklatıldı” olarak görünür."
        />
        {loading ? (
          <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" />
        ) : loadError !== null ? (
          <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            <p className="font-medium">Reklam hesapları yüklenemedi.</p>
            {loadError && <p className="mt-1">{loadError}</p>}
            <button type="button" className="secondary-button mt-3" onClick={() => void load()}>
              Tekrar dene
            </button>
          </div>
        ) : platforms.length === 0 ? (
          <EmptyState message="Henüz reklam hesabı yok. Meta hesabınızı Meta bağlantıları sayfasından bağlayın." />
        ) : (
          <div className="space-y-3">
            {platforms.map((p) => {
              const status = entityStatusStyle(p.status);
              return (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{p.name ?? "—"}</p>
                    <p className="text-xs text-muted">Meta hesap kimliği: {p.metaAccountId ?? "—"}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span className="text-xs text-muted">
                      {p.syncedAt ? `Son eşitleme: ${formatDate(p.syncedAt)}` : "Henüz eşitlenmedi"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
