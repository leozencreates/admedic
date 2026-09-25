"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
import { LanguageSwitcher } from "../_components/language-switcher";
import { scopeLabel } from "../_lib/meta-scopes";

const WARNING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const STATUS_TONE: Record<string, Tone> = {
  CONNECTED: "green",
  EXPIRED: "amber",
  REVOKED: "red",
  DEGRADED: "amber",
};
const TYPE_LABEL: Record<string, string> = {
  BUSINESS_MANAGER: "Business Manager",
  AD_ACCOUNT: "Reklam Hesabı",
  PAGE: "Sayfa",
  INSTAGRAM: "Instagram",
  PIXEL: "Pixel",
  WHATSAPP_BUSINESS: "WhatsApp Business",
};
interface Conn {
  id: string;
  type: string;
  status: string;
  name: string | undefined;
  metaAccountId: string | undefined;
  scopes: string[];
  missingPermissions: string[];
  appId: string | undefined;
  expiresAt: string | undefined;
  lastError: string | null;
  createdAt: string;
}
interface Account {
  id: string;
  name: string;
  metaAccountId: string | undefined;
  currency: string;
  status: string;
  isDefault: boolean;
  connection: { status: string; expiresAt: string | undefined } | null;
}
export default function MetaConnectionsPage() {
  const [conns, setConns] = useState<Conn[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [authUrl, setAuthUrl] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  async function load() {
    setLoading(true);
    try {
      const data = await api<{ connections: Conn[] }>("/api/meta/connections");
      setConns(data.connections ?? []);
    } catch { setConns([]); }
    try {
      const a = await api<{ accounts: Account[] }>("/api/platforms/accounts");
      setAccounts(a.accounts ?? []);
    } catch { setAccounts([]); }
    setLoading(false);
  }
  async function connect() {
    try {
      const data = await api<{ authUrl: string }>("/api/meta/oauth");
      setAuthUrl(data.authUrl);
      window.location.href = data.authUrl;
    } catch { setMsg({ kind: "err", text: "OAuth başlatma başarısız." }); }
  }
  async function refresh(id: string) {
    try {
      const r = await api<{ connection: { status: string; expiresAt: string | undefined; refreshed: boolean } }>(
        "/api/meta/connections/" + id + "/refresh",
        "POST",
        {},
      );
      const c = r.connection;
      setMsg({ kind: "ok", text: `Yenileme başarılı: ${c.status}` });
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? "Yenileme başarısız." });
    }
    setTimeout(load, 2000);
  }
  async function setDefault(id: string) {
    try {
      await api<{ account: { id: string; isDefault: boolean } }>(
        "/api/platforms/accounts/" + id,
        "PATCH",
        { isDefault: true },
      );
      setMsg({ kind: "ok", text: "Varsayılan hesap güncellendi." });
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? "İşlem başarısız." });
    }
    setTimeout(load, 1500);
  }
  function daysLeft(expiresAt: string | undefined): number | null {
    if (!expiresAt) return null;
    const d = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 86_400_000));
    return d;
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
      {msg && (
        <div role="alert" className={`rounded-xl border p-3 text-sm ${msg.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
          {msg.text}
        </div>
      )}
      <Card>
        <SectionHeading title="Bağlantılar" description="Bağlı Meta hesapları, izin durumu ve son kullanma tarihi." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : conns.length === 0 ? <EmptyState message="Henüz Meta hesabı bağlı değil." /> : (
          <div className="space-y-3">
            {conns.map((c) => {
              const expired = c.status === "EXPIRED" || c.status === "REVOKED";
              const soon = !expired && daysLeft(c.expiresAt) !== null && daysLeft(c.expiresAt)! <= 3;
              return (
                <div key={c.id} className={`rounded-lg border p-3 ${expired ? "border-rose-300 bg-rose-50/40" : soon ? "border-amber-300 bg-amber-50/40" : "border-slate-200"}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{TYPE_LABEL[c.type] ?? c.type}</p>
                      <p className="text-xs text-slate-500">{c.name ?? c.metaAccountId ?? "-"}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={STATUS_TONE[c.status] ?? "gray"}>{c.status}</Badge>
                      <span className="text-xs text-slate-400">{new Date(c.createdAt).toLocaleDateString("tr-TR")}</span>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {c.expiresAt && (
                      <span className={soon || expired ? "text-amber-700" : "text-slate-500"}>
                        Son kullanma: {new Date(c.expiresAt).toLocaleDateString("tr-TR")} ({daysLeft(c.expiresAt)} gün)
                      </span>
                    )}
                    {!expired && daysLeft(c.expiresAt) !== null && daysLeft(c.expiresAt)! <= 3 && (
                      <button onClick={() => refresh(c.id)} className="rounded bg-amber-600 px-2 py-0.5 text-white hover:bg-amber-700">Yenile</button>
                    )}
                  </div>
                  {c.missingPermissions.length > 0 && (
                    <div className="mt-1 text-xs text-amber-700">
                      Eksik izinler: {c.missingPermissions.map((s) => scopeLabel(s)).join(", ")}
                    </div>
                  )}
                  {c.lastError && <div className="mt-1 text-xs text-rose-600">Hata: {c.lastError}</div>}
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <Card>
        <SectionHeading title="Reklam Hesapları" description="Varsayılan hesap Meta operasyonları için kullanılır." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : accounts.length === 0 ? <EmptyState message="Henüz reklam hesabı bağlı değil." /> : (
          <div className="space-y-3">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">{a.name} {a.isDefault ? "(varsayılan)" : ""}</p>
                  <p className="text-xs text-slate-500">{a.metaAccountId ?? "-"} · {a.currency} · {a.status}</p>
                  <p className="text-xs text-slate-400">Bağlantı: {a.connection?.status ?? "-"}</p>
                </div>
                {!a.isDefault && (
                  <button onClick={() => setDefault(a.id)} className="rounded bg-slate-800 px-2 py-0.5 text-white text-xs hover:bg-slate-900">Varsayılan Yap</button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}