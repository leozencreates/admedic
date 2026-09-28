"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, defaultAccountCurrency } from "../_lib/client-api";
import { formatMoneyUnits } from "../_lib/format";
import { experimentStatusStyle, languageName } from "../_lib/labels";
import { Badge, PageHeader } from "./ui";
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
  const [error, setError] = useState<string | null>(null);
  const [currency, setCurrency] = useState("EUR");
  async function load() {
    setLoading(true);
    setError(null);
    try {
      setItems(
        (await api<{ experiments: Test[] }>("/api/experiments")).experiments,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    void defaultAccountCurrency().then(setCurrency);
  }, []);
  return (
    <div className="space-y-6">
      <PageHeader
        title="A/B testleri"
        crumbs={[{ label: "Testler" }]}
        description="Onaylı reklamlardan oluşturulan deneyleri ve elle girilen sonuçlarını izleyin; Meta'da otomatik yayın yapılmaz."
        actions={
          <>
            <Link href="/library" className="primary-button">
              Onaylı reklamdan deney oluştur
            </Link>
            <Link href="/experiments" className="secondary-button">
              Test hesaplayıcı
            </Link>
          </>
        }
      />
      {loading ? (
        <div className="studio-card animate-pulse" role="status">
          Deneyler yükleniyor…
        </div>
      ) : error !== null ? (
        <div className="studio-card" role="alert">
          <p className="font-medium text-rose-800">Deneyler yüklenemedi.</p>
          {error && <p className="mt-1 text-sm text-slate-700">{error}</p>}
          <button className="secondary-button mt-3" onClick={load}>
            Tekrar dene
          </button>
        </div>
      ) : !items.length ? (
        <div className="studio-card py-12 text-center">
          <h2>Henüz kayıtlı deney yok</h2>
          <p className="mt-3 text-sm text-muted">
            Kütüphanedeki bir reklamı onaylayın ve “A/B deneyi oluştur”
            düğmesini kullanın.
          </p>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {items.map((item) => {
            const status = experimentStatusStyle(item.status);
            return (
              <Link
                href={`/tests/${item.id}`}
                className="studio-card block transition hover:border-violet-300"
                key={item.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <span className="text-xs text-muted">
                    {languageName(item.snapshot.language)} · A/B testi
                  </span>
                </div>
                <h2 className="mt-5">{item.draft.name}</h2>
                <p className="mt-3 text-sm text-muted">
                  {item.elapsedDays} / {item.snapshot.duration} gün · Planlanan
                  bütçe {formatMoneyUnits(item.snapshot.budget, currency)}
                </p>
                <div className="my-4 h-2 rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-violet-500"
                    style={{
                      width: `${Math.min(100, (item.elapsedDays / item.snapshot.duration) * 100)}%`,
                    }}
                  />
                </div>
                <p className="text-sm text-violet-700">Sonuçları incele</p>
              </Link>
            );
          })}
        </div>
      )}
      <p className="text-xs text-muted">
        Son güncellenen en fazla 100 deney gösterilir.
      </p>
    </div>
  );
}
