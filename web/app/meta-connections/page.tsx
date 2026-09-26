"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
import { isRequiredScope, optionalScopesMissing, scopeLabel } from "../_lib/meta-scopes";

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
  name: string | null;
  metaAccountId: string | null;
  scopes: string[];
  missingPermissions: string[];
  pageId: string | null;
  instaId: string | null;
  pixelId: string | null;
  whatsappPhoneNumberId: string | null;
  whatsappBusinessId: string | null;
  appId: string | null;
  expiresAt: string | null;
  lastError: string | null;
  createdAt: string;
}
interface Account {
  id: string;
  name: string;
  metaAccountId: string | null;
  currency: string;
  status: string;
  isDefault: boolean;
  connection: { status: string; expiresAt: string | null } | null;
}
type IdForm = {
  pixelId: string;
  whatsappPhoneNumberId: string;
  whatsappBusinessId: string;
  pageId: string;
  instaId: string;
};
const ID_FIELDS: Array<{ key: keyof IdForm; label: string; hint: string }> = [
  { key: "pixelId", label: "Pixel / Dataset ID", hint: "Conversions API hedefi" },
  { key: "whatsappPhoneNumberId", label: "WhatsApp phone_number_id", hint: "Cloud API webhook yönlendirmesi" },
  { key: "whatsappBusinessId", label: "WhatsApp Business Account ID", hint: "WABA kimliği" },
  { key: "pageId", label: "Facebook Sayfa ID", hint: "Messenger / Lead Ads webhook eşlemesi" },
  { key: "instaId", label: "Instagram Hesap ID", hint: "Instagram DM webhook eşlemesi" },
];

/** Callback yönlendirmesinden gelen sonuç (`?status=connected|error&missing=&optional=&reason=`). */
interface CallbackNotice {
  status: "connected" | "error";
  missing: string[];
  optional: string[];
  reason: string | null;
  pages: number | null;
  accounts: number | null;
}

function readCallbackNotice(search: string): CallbackNotice | null {
  const params = new URLSearchParams(search);
  const status = params.get("status");
  if (status !== "connected" && status !== "error") return null;
  const list = (key: string) => (params.get(key) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const num = (key: string) => (params.get(key) !== null && params.get(key) !== "" ? Number(params.get(key)) : null);
  return {
    status,
    missing: list("missing"),
    optional: list("optional"),
    reason: params.get("reason"),
    pages: num("pages"),
    accounts: num("accounts"),
  };
}

export default function MetaConnectionsPage() {
  const [conns, setConns] = useState<Conn[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [notice, setNotice] = useState<CallbackNotice | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [idForm, setIdForm] = useState<IdForm>({ pixelId: "", whatsappPhoneNumberId: "", whatsappBusinessId: "", pageId: "", instaId: "" });
  const [saving, setSaving] = useState(false);

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
      window.location.href = data.authUrl;
    } catch (e: any) { setMsg({ kind: "err", text: e?.message ?? "OAuth başlatma başarısız." }); }
  }
  async function refresh(id: string) {
    try {
      const r = await api<{ connection: { status: string; expiresAt: string | null; refreshed: boolean } }>(
        "/api/meta/connections/" + id + "/refresh",
        "POST",
        {},
      );
      setMsg({ kind: "ok", text: `Yenileme başarılı: ${r.connection.status}` });
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? "Yenileme başarısız." });
    }
    load();
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
    load();
  }
  async function disconnect(id: string) {
    if (!window.confirm("Bağlantı kesilecek ve ilgili reklam hesapları duraklatılacak. Emin misiniz?")) return;
    try {
      const r = await api<{ connection: { id: string; status: string; adAccountsPaused: number } }>(
        "/api/meta/connections/" + id,
        "DELETE",
      );
      setMsg({ kind: "ok", text: `Bağlantı kesildi (${r.connection.adAccountsPaused} reklam hesabı duraklatıldı).` });
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? "Bağlantı kesilemedi." });
    }
    load();
  }
  function startEdit(c: Conn) {
    setEditing(c.id);
    setIdForm({
      pixelId: c.pixelId ?? "",
      whatsappPhoneNumberId: c.whatsappPhoneNumberId ?? "",
      whatsappBusinessId: c.whatsappBusinessId ?? "",
      pageId: c.pageId ?? "",
      instaId: c.instaId ?? "",
    });
  }
  async function saveIds(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      const r = await api<{ connection: Conn; changed: string[] }>(
        "/api/meta/connections/" + editing,
        "PATCH",
        {
          pixelId: idForm.pixelId.trim() || null,
          whatsappPhoneNumberId: idForm.whatsappPhoneNumberId.trim() || null,
          whatsappBusinessId: idForm.whatsappBusinessId.trim() || null,
          pageId: idForm.pageId.trim() || null,
          instaId: idForm.instaId.trim() || null,
        },
      );
      setMsg({ kind: "ok", text: r.changed.length > 0 ? `Kimlikler güncellendi (${r.changed.join(", ")}).` : "Değişiklik yok." });
      setEditing(null);
      load();
    } catch (err: any) {
      setMsg({ kind: "err", text: err?.message ?? "Kimlikler kaydedilemedi." });
    }
    setSaving(false);
  }
  function daysLeft(expiresAt: string | null): number | null {
    if (!expiresAt) return null;
    return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 86_400_000));
  }
  useEffect(() => {
    load();
    // Callback sonucu sorgu parametrelerinden okunur; URL temizlenir (yenilemede tekrar gösterilmez).
    try {
      const parsed = readCallbackNotice(window.location.search);
      if (parsed) {
        setNotice(parsed);
        window.history.replaceState(null, "", window.location.pathname);
      }
    } catch {
      /* SSR/önizleme: window yok */
    }
  }, []);

  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">META BAĞLANTILARI</span>
        <h1>Meta Hesap Bağlantısı</h1>
        <p className="text-sm text-slate-500">Business Manager, reklam hesapları, sayfalar, Instagram ve WhatsApp hesaplarınızı bağlayın.</p>
        <div className="mt-6"><button onClick={connect} className="primary-button">Meta ile Bağlantı Kur</button></div>
      </header>
      {notice && (
        <div
          role="alert"
          className={`rounded-xl border p-3 text-sm ${notice.status === "connected" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"}`}
        >
          {notice.status === "connected" ? (
            <div className="space-y-1">
              <p className="font-medium">
                Meta bağlantısı kuruldu.
                {notice.pages !== null && notice.pages > 0 ? ` ${notice.pages} sayfa bağlandı.` : ""}
                {notice.accounts !== null && notice.accounts > 0 ? ` ${notice.accounts} reklam hesabı keşfedildi.` : ""}
              </p>
              {notice.missing.length > 0 && (
                <p className="text-rose-700">
                  Eksik ZORUNLU izinler: {notice.missing.map(scopeLabel).join(", ")}. Kampanya ve lead işlemleri için Meta'da yeniden yetkilendirin.
                </p>
              )}
              {notice.optional.length > 0 && (
                <p className="text-amber-700">
                  Eksik opsiyonel izinler: {notice.optional.map(scopeLabel).join(", ")} (mesajlaşma/Instagram/WhatsApp özellikleri sınırlı).
                </p>
              )}
            </div>
          ) : (
            <p>Meta bağlantısı kurulamadı{notice.reason ? `: ${notice.reason}` : "."}</p>
          )}
        </div>
      )}
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
              const left = daysLeft(c.expiresAt);
              const soon = !expired && left !== null && left <= 3;
              // missingPermissions yalnızca zorunlu izinleri taşır; opsiyoneller verilen izin listesinden türetilir.
              const requiredMissing = c.missingPermissions.filter(isRequiredScope);
              const optionalMissing = c.scopes.length > 0
                ? optionalScopesMissing(c.scopes)
                : c.missingPermissions.filter((s) => !isRequiredScope(s));
              const isEditing = editing === c.id;
              return (
                <div key={c.id} className={`rounded-lg border p-3 ${expired ? "border-rose-300 bg-rose-50/40" : soon ? "border-amber-300 bg-amber-50/40" : "border-slate-200"}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{TYPE_LABEL[c.type] ?? c.type}</p>
                      <p className="text-xs text-slate-500">{c.name ?? c.metaAccountId ?? c.pageId ?? "-"}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={STATUS_TONE[c.status] ?? "gray"}>{c.status}</Badge>
                      <span className="text-xs text-slate-400">{new Date(c.createdAt).toLocaleDateString("tr-TR")}</span>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {c.expiresAt ? (
                      <span className={soon || expired ? "text-amber-700" : "text-slate-500"}>
                        Son kullanma: {new Date(c.expiresAt).toLocaleDateString("tr-TR")} ({left} gün)
                      </span>
                    ) : (
                      <span className="text-slate-500">Son kullanma: süresiz (Meta iptal edene kadar)</span>
                    )}
                    {!expired && (
                      <button onClick={() => refresh(c.id)} className={`rounded px-2 py-0.5 text-white ${soon ? "bg-amber-600 hover:bg-amber-700" : "bg-slate-700 hover:bg-slate-800"}`}>Yenile</button>
                    )}
                    {!expired && (
                      <button onClick={() => disconnect(c.id)} className="rounded bg-rose-600 px-2 py-0.5 text-white hover:bg-rose-700">Bağlantıyı Kes</button>
                    )}
                    {expired && (
                      <button onClick={connect} className="rounded bg-slate-800 px-2 py-0.5 text-white hover:bg-slate-900">Yeniden Bağlan</button>
                    )}
                    <button onClick={() => (isEditing ? setEditing(null) : startEdit(c))} className="rounded border border-slate-300 px-2 py-0.5 text-slate-700 hover:bg-slate-100">
                      {isEditing ? "Vazgeç" : "Kimlikleri Düzenle"}
                    </button>
                  </div>
                  <div className="mt-2 grid gap-x-4 gap-y-0.5 text-xs text-slate-500 sm:grid-cols-2">
                    <span>Pixel/Dataset: {c.pixelId ?? "-"}</span>
                    <span>WhatsApp phone_number_id: {c.whatsappPhoneNumberId ?? "-"}</span>
                    <span>WABA: {c.whatsappBusinessId ?? "-"}</span>
                    <span>Sayfa: {c.pageId ?? "-"} · Instagram: {c.instaId ?? "-"}</span>
                  </div>
                  {requiredMissing.length > 0 && (
                    <div className="mt-1 text-xs text-rose-700">
                      Eksik zorunlu izinler: {requiredMissing.map(scopeLabel).join(", ")}
                    </div>
                  )}
                  {optionalMissing.length > 0 && (
                    <div className="mt-1 text-xs text-amber-700">
                      Eksik opsiyonel izinler: {optionalMissing.map(scopeLabel).join(", ")}
                    </div>
                  )}
                  {c.lastError && <div className="mt-1 text-xs text-rose-600">Hata: {c.lastError}</div>}
                  {isEditing && (
                    <form onSubmit={saveIds} className="mt-3 grid gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-2">
                      <p className="text-xs text-slate-500 sm:col-span-2">
                        Meta App Review tamamlanana kadar kimlikler elle eşlenir. Boş bırakılan alan temizlenir.
                      </p>
                      {ID_FIELDS.map((f) => (
                        <label key={f.key} className="flex flex-col gap-1 text-xs text-slate-700">
                          {f.label} <span className="text-slate-400">({f.hint})</span>
                          <input
                            className="rounded border border-slate-300 px-2 py-1 text-sm"
                            value={idForm[f.key]}
                            onChange={(e) => setIdForm({ ...idForm, [f.key]: e.target.value })}
                            placeholder="-"
                          />
                        </label>
                      ))}
                      <div className="sm:col-span-2">
                        <button type="submit" disabled={saving} className="rounded bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-60">
                          {saving ? "Kaydediliyor…" : "Kimlikleri Kaydet"}
                        </button>
                      </div>
                    </form>
                  )}
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
