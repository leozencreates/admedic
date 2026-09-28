"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../_lib/client-api";
import { recommendationStatusStyle } from "../_lib/labels";
import { RECOMMENDATION_KIND_LABEL, recommendationKind } from "../_lib/recommendation-kinds";
import { Badge } from "./ui";

type Rec = { id: string; type: string; action?: Record<string, unknown> | null; title: string; description: string; status: string; createdAt: string };
export function RecommendationLibrary() {
  const [recs, setRecs] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // İşlem hatası listeyi silmez; yükleme hatasından ayrı gösterilir.
  const [actionError, setActionError] = useState("");
  async function load() {
    setLoading(true); setError(null);
    try { setRecs((await api<{ recommendations: Rec[] }>("/api/recommendations")).recommendations); }
    catch (e) { setError(e instanceof Error ? e.message : ""); }
    finally { setLoading(false); }
  }
  async function submitForApproval(id: string) {
    setActionError("");
    try { await api(`/api/recommendations/${id}`, "PATCH", { status: "PENDING" }); await load(); }
    catch (e) { setActionError(e instanceof Error ? e.message : "Öneri onaya gönderilemedi. Tekrar deneyin."); }
  }
  useEffect(() => { void load(); }, []);
  return (
    <div className="space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">OPTİMİZASYON ÖNERİLERİ</span>
        <h1>Veriye dayalı iyileştirme önerileri.</h1>
        <p>Tamamlanan deneylere göre üretilen bütçe ve yayın önerileri; onaylanmadan uygulanmaz.</p>
      </header>
      {actionError && (
        <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{actionError}</p>
      )}
      {loading ? (
        <div className="studio-card animate-pulse" role="status">Öneriler yükleniyor…</div>
      ) : error !== null ? (
        <div className="studio-card" role="alert">
          <p className="font-medium text-rose-800">Öneriler yüklenemedi.</p>
          {error && <p className="mt-1 text-sm text-slate-700">{error}</p>}
          <button className="secondary-button mt-3" onClick={load}>Tekrar dene</button>
        </div>
      ) : !recs.length ? (
        <div className="studio-card py-12 text-center">
          <h2>Henüz öneri yok</h2>
          <p className="mt-3 text-sm text-muted">Deney tamamlandıktan sonra öneri oluşturun.</p>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {recs.map((rec) => {
            const kind = recommendationKind(rec);
            const status = recommendationStatusStyle(rec.status);
            return (
              <article className="studio-card" key={rec.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <span className="text-xs text-muted">{RECOMMENDATION_KIND_LABEL[kind] ?? "Diğer öneri"}</span>
                </div>
                <h2 className="mt-4">{rec.title}</h2>
                <p className="mt-2 text-sm text-muted">{rec.description}</p>
                <div className="mt-4 flex gap-3">
                  <Link href="/recommendations" className="primary-button">Ayrıntıları incele</Link>
                  {rec.status === "DRAFT" && (
                    <button className="secondary-button" onClick={() => void submitForApproval(rec.id)}>Onaya gönder</button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <p className="text-xs text-muted">Son eklenen en fazla 50 öneri gösterilir.</p>
    </div>
  );
}
