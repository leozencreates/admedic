"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
import { LanguageSwitcher } from "../_components/language-switcher";
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const STATUS_TONE: Record<string, Tone> = { CONNECTED: "green", DISCONNECTED: "red", PENDING: "amber" };
export default function PlatformsPage() {
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try { const data = await api<{ platforms: any[] }>("/api/platforms"); setPlatforms(data.platforms); } catch { setPlatforms([]); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">PLATFORM BAĞLANTILARI</span>
        <h1>Platform Bağlantıları</h1>
        <p className="text-sm text-slate-500">Google Ads, TikTok ve Meta hesablarınızı buradan bağlayın.</p>
      </header>
      <Card>
        <SectionHeading title="Bağlı Platformlar" description="Reklama hesapları ve durumları." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : platforms.length === 0 ? <EmptyState message="Henüz platform bağlantısı yok." /> : (
          <div className="space-y-3">
            {platforms.map((p: any) => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div><p className="text-sm font-medium text-slate-900">{p.name ?? p.platform ?? "-"}</p><p className="text-xs text-slate-500">{p.metaAccountId ?? p.platform ?? "-"}</p></div>
                <div className="flex items-center gap-2">
                  <Badge tone={p.status === "CONNECTED" ? "green" : "amber"}>{p.status ?? "PENDING"}</Badge>
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
