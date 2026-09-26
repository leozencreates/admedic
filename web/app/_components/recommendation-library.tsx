"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../_lib/client-api";
import { RECOMMENDATION_KIND_LABEL, RECOMMENDATION_STATUS_LABEL, recommendationKind } from "../_lib/recommendation-kinds";

type Rec = { id: string; type: string; action?: Record<string, unknown> | null; title: string; description: string; status: string; createdAt: string };
export function RecommendationLibrary() {
  const [recs, setRecs] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true); setError("");
    try { setRecs((await api<{ recommendations: Rec[] }>("/api/recommendations")).recommendations); }
    catch (e) { setError(e instanceof Error ? e.message : "Yüklenemedi."); }
    finally { setLoading(false); }
  }
  async function submitForApproval(id: string) {
    setError("");
    try { await api(`/api/recommendations/${id}`, "PATCH", { status: "PENDING" }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Onaya gönderilemedi."); }
  }
  useEffect(() => { void load(); }, []);
  return <div className="space-y-6">
    <header className="studio-hero"><span className="eyebrow">OPTİMİZASYON ÖNERİLERİ</span><h1>Veriye dayalı iyileştirme önerileri.</h1><p>Tamamlanan deneylere göre üretilen bütçe ve yayın önerileri; onaylanmadan uygulanmaz.</p></header>
    {loading ? <div className="studio-card animate-pulse" role="status">Öneriler yükleniyor…</div> : error ? <div className="studio-card" role="alert"><p>{error}</p><button className="secondary-button mt-3" onClick={load}>Tekrar dene</button></div> : !recs.length ? <div className="studio-card py-12 text-center"><h2>Henüz öneri yok</h2><p className="mt-3 text-sm text-slate-500">Deney tamamlandıktan sonra öneri oluşturun.</p></div> : <div className="grid gap-5 md:grid-cols-2">{recs.map(rec => { const kind = recommendationKind(rec); return <article className="studio-card" key={rec.id}><div className="flex items-center justify-between"><span className="status-pill">{RECOMMENDATION_STATUS_LABEL[rec.status] ?? rec.status}</span><span className="text-xs text-slate-400">{RECOMMENDATION_KIND_LABEL[kind] ?? kind}</span></div><h2 className="mt-4">{rec.title}</h2><p className="mt-2 text-sm text-slate-500">{rec.description}</p><div className="mt-4 flex gap-3"><Link href="/recommendations" className="primary-button">Detayları incele</Link>{rec.status === "DRAFT" && <button className="secondary-button" onClick={() => void submitForApproval(rec.id)}>Onaya gönder</button>}</div></article>; })}</div>}<p className="text-xs text-slate-400">Son eklenen en fazla 50 öneri gösterilir.</p></div>;
}
