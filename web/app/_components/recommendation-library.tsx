"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../_lib/client-api";

type Rec = { id: string; type: string; title: string; description: string; status: string; createdAt: string };
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
  useEffect(() => { void load(); }, []);
  return <div className="space-y-6">
    <header className="studio-hero"><span className="eyebrow">OPTİMİZASYON ÖNERİLERİ</span><h1>Veriye dayalı iyileştirme önerileri.</h1><p>Tamamlanan deneylere göre üretilen bütçe ve yayın önerileri.</p></header>
    {loading ? <div className="studio-card animate-pulse" role="status">Öneriler yükleniyor…</div> : error ? <div className="studio-card" role="alert"><p>{error}</p><button className="secondary-button mt-3" onClick={load}>Tekrar dene</button></div> : !recs.length ? <div className="studio-card py-12 text-center"><h2>Henüz öneri yok</h2><p className="mt-3 text-sm text-slate-500">Deney tamamlandıktan sonra Meta metriklerini senkronize edin.</p></div> : <div className="grid gap-5 md:grid-cols-2">{recs.map(rec => <article className="studio-card" key={rec.id}><div className="flex items-center justify-between"><span className="status-pill">{rec.status}</span><span className="text-xs text-slate-400">{rec.type}</span></div><h2 className="mt-4">{rec.title}</h2><p className="mt-2 text-sm text-slate-500">{rec.description}</p><div className="mt-4 flex gap-3"><Link href="#" className="primary-button">Detayları incele</Link>{rec.status === "DRAFT" && <button className="secondary-button">Onaya gönder</button>}</div></article>)}</div>}<p className="text-xs text-slate-400">Son eklenen en fazla 50 öneri gösterilir.</p></div>;
}
