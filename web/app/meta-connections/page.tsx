"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
import { LanguageSwitcher } from "../_components/language-switcher";
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const STATUS_TONE: Record<string, Tone> = { CONNECTED: "green", EXPIRED: "amber", REVOKED: "red", DEGRADED: "amber" };
const TYPE_LABEL: Record<string, string> = { BUSINESS_MANAGER: "Business Manager", AD_ACCOUNT: "Reklam Hesabı", PAGE: "Sayfa", INSTAGRAM: "Instagram", PIXEL: "Pixel" };
interface MetaConnectionData { id: string; type: string; status: string; name: string | undefined; metaAccountId: string | undefined; scopes: string[]; createdAt: string; expiresAt: string | undefined; }
export default function MetaConnectionsPage() {
  const [conns, setConns] = useState<MetaConnectionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [authUrl, setAuthUrl] = useState("");
  async function load() {
    setLoading(true);
    try { const data = await api<{ connections: MetaConnectionData[] }>("/api/meta/connections"); setConns(data.connections ?? []); } catch { setConns([]); }
    setLoading(false);
  }
  async function connect() {
    try { const data = await api<{ authUrl: string }>("/api/meta/oauth"); setAuthUrl(data.authUrl); window.location.href = data.authUrl; } catch {}
  }
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">META BAĞLANTILARI</span>
        <h1>Meta Hesap Bağlantısı</h1>
        <p className="text-sm text-slate-500">Business Manager, reklam hesapları ve sayfalarınızı bağlayın.</p>
        <div className="mt-6"><button onClick={connect} className="primary-button">Meta ile Bağlantı Kur</button></div>
      </header>
      <Card>
        <SectionHeading title="Bağlantılar" description="Bağlı Meta hesapları ve izin durumu." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : conns.length === 0 ? <EmptyState message="Henüz Meta hesabı bağlı değil." /> : (
          <div className="space-y-3">
            {conns.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div><p className="text-sm font-medium text-slate-900">{TYPE_LABEL[c.type] ?? c.type}</p><p className="text-xs text-slate-500">{c.name ?? c.metaAccountId ?? "-"}</p></div>
                <div className="flex items-center gap-2">
                  <Badge tone={STATUS_TONE[c.status] ?? "gray"}>{c.status}</Badge>
                  <span className="text-xs text-slate-400">{new Date(c.createdAt).toLocaleDateString("tr-TR")}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
