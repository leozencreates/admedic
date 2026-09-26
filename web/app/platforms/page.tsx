"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const STATUS_TONE: Record<string, Tone> = { ACTIVE: "green", PAUSED: "amber", ARCHIVED: "gray" };
interface Platform { id: string; name: string; status: string; syncedAt: string | null; metaAccountId: string | null }
export default function PlatformsPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try { const data = await api<{ platforms: Platform[] }>("/api/platforms"); setPlatforms(data.platforms); } catch { setPlatforms([]); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">PLATFORM BAĞLANTILARI</span>
        <h1>Platform Bağlantıları</h1>
        <p className="text-sm text-slate-500">Reklam hesaplarınız ve durumları. Meta hesaplarını <Link href="/meta-connections" className="underline">Meta Bağlantıları</Link> sayfasından bağlayın.</p>
      </header>
      <Card>
        <SectionHeading title="Reklam Hesapları" description="Bağlı reklam hesapları; PAUSED = bağlantı kopmuş veya duraklatılmış." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : platforms.length === 0 ? <EmptyState message="Henüz platform bağlantısı yok." /> : (
          <div className="space-y-3">
            {platforms.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div><p className="text-sm font-medium text-slate-900">{p.name ?? "-"}</p><p className="text-xs text-slate-500">{p.metaAccountId ?? "-"}</p></div>
                <div className="flex items-center gap-2">
                  <Badge tone={STATUS_TONE[p.status] ?? "gray"}>{p.status ?? "-"}</Badge>
                  <span className="text-xs text-slate-400">{p.syncedAt ? new Date(p.syncedAt).toLocaleDateString("tr-TR") : "-"}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
