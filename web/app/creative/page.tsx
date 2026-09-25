"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
import { LanguageSwitcher } from "../_components/language-switcher";
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const STATUS_TONE: Record<string, Tone> = { DRAFT: "gray", IN_REVIEW: "amber", APPROVED: "green", PUBLISHED: "blue", REJECTED: "red" };
const LANG_LABEL: Record<string, string> = { TR: "Türkçe", EN: "English", DE: "Deutsch", RU: "Русский", AR: "العربية", FR: "Français", NL: "Nederlands", PL: "Polski" };
interface CreativeData { id: string; name: string; status: string; languages: string[]; variations: number; primaryText?: string; headline?: string; createdAt: string; }
export default function CreativePage() {
  const [creatives, setCreatives] = useState<CreativeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  async function load() {
    setLoading(true);
    try { const data = await api<{ creatives: CreativeData[] }>("/api/creative"); setCreatives(data.creatives); } catch { setCreatives([]); }
    setLoading(false);
  }
  async function generate() {
    if (!name) return;
    try { await api("/api/creative", "POST", JSON.stringify({ name })); setName(""); load(); } catch {}
  }
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">KREATİF ÜRETİMİ</span>
        <h1>Kreatif Üret</h1>
        <p className="text-sm text-slate-500">TR/EN/DE/RU/AR + FR/NL/PL için çok dilli kreatif üretimi.</p>
      </header>
      <Card>
        <SectionHeading title="Yeni Kreatif" description="Kampanya için çok dilli kreatif üretin." />
        <div className="mt-6 space-y-4">
          <input placeholder="Kreatif adı" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm focus:border-violet-500 focus:ring-1 focus:ring-violet-400/30" />
          <button onClick={generate} className="primary-button">AI ile Kreatif Üret</button>
        </div>
      </Card>
      <Card>
        <SectionHeading title="Kreatifler" description="Üretilen kreatif varyasyonları." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : creatives.length === 0 ? <EmptyState message="Henüz kreatif yok." /> : (
          <div className="space-y-3">
            {creatives.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div><p className="text-sm font-medium text-slate-900">{c.name}</p><p className="text-xs text-slate-500">{c.variations} varyasyon · {(c.languages ?? []).map((l) => LANG_LABEL[l] ?? l).join(", ") || "-"}</p></div>
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
