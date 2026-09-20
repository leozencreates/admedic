"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, labels } from "../_lib/client-api";
type Test = {
  id: string;
  status: string;
  elapsedDays: number;
  draft: { name: string };
  snapshot: { duration: number; language: string; budget: number };
};
export function TestLibrary() {
  const [items, setItems] = useState<Test[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      setItems(
        (await api<{ experiments: Test[] }>("/api/experiments")).experiments,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Yüklenemedi.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">KAYITLI DENEYLER / 02</span>
        <h1>Her testten bir şey öğrenin.</h1>
        <p>
          Onaylı reklamlardan oluşturulan deneyler, sabit test planları ve
          kaydedilmiş sonuçlar.
        </p>
        <div className="hero-tags">
          <span>Manuel metrik girişi</span>
          <span>Otomatik Meta yayını yok</span>
        </div>
      </header>
      <div className="flex flex-wrap gap-3">
        <Link href="/library" className="primary-button">
          Onaylı reklamdan deney oluştur
        </Link>
        <Link href="/experiments" className="secondary-button">
          Hızlı hesaplayıcı
        </Link>
      </div>
      {loading ? (
        <div className="studio-card animate-pulse" role="status">
          Deneyler yükleniyor…
        </div>
      ) : error ? (
        <div className="studio-card" role="alert">
          <p>{error}</p>
          <button className="secondary-button mt-3" onClick={load}>
            Tekrar dene
          </button>
        </div>
      ) : !items.length ? (
        <div className="studio-card py-12 text-center">
          <h2>Henüz kayıtlı deney yok</h2>
          <p className="mt-3 text-sm text-slate-500">
            Kütüphanedeki bir reklamı onaylayın ve “A/B deneyi oluştur”
            düğmesini kullanın.
          </p>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {items.map((item) => (
            <Link
              href={`/tests/${item.id}`}
              className="studio-card block transition hover:border-violet-300"
              key={item.id}
            >
              <div className="flex items-center justify-between">
                <span className="status-pill">{labels[item.status]}</span>
                <span className="text-xs text-slate-400">
                  {item.snapshot.language} · A/B
                </span>
              </div>
              <h2 className="mt-5">{item.draft.name}</h2>
              <p className="mt-3 text-sm text-slate-500">
                {item.elapsedDays} / {item.snapshot.duration} gün · Planlanan
                bütçe €{item.snapshot.budget.toFixed(2)}
              </p>
              <div className="my-4 h-2 rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-violet-500"
                  style={{
                    width: `${Math.min(100, (item.elapsedDays / item.snapshot.duration) * 100)}%`,
                  }}
                />
              </div>
              <p className="text-sm text-violet-600">Sonuçları incele →</p>
            </Link>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-400">
        Son güncellenen en fazla 100 deney gösterilir.
      </p>
    </div>
  );
}
