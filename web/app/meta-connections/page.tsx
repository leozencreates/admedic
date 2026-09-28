"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { formatDay } from "../_lib/format";
import { entityStatusStyle, metaConnectionStyle } from "../_lib/labels";
import { Badge, Card, EmptyState, IntroPanel, PageHeader, SectionHeading } from "../_components/ui";
import { ConfirmDialog } from "../_components/dialog";
import { isRequiredScope, optionalScopesMissing, scopeLabel } from "../_lib/meta-scopes";

/** Meta bağlantı türü (K9-C: Meta'nın Türkçe arayüzündeki adlar). */
const TYPE_LABEL: Record<string, string> = {
  BUSINESS_MANAGER: "İşletme portföyü",
  AD_ACCOUNT: "Reklam hesabı",
  PAGE: "Facebook Sayfası",
  INSTAGRAM: "Instagram hesabı",
  PIXEL: "Meta Pikseli",
  WHATSAPP_BUSINESS: "WhatsApp Business hesabı",
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
/** Kimlik numaraları ham alan adıyla değil, açıklamasıyla ve katlanır bölümde gösterilir (K9-C #5). */
const ID_FIELDS: Array<{ key: keyof IdForm; label: string; short: string; hint: string }> = [
  {
    key: "pixelId",
    label: "Meta Pikseli (veri kümesi) kimliği",
    short: "Meta Pikseli",
    hint: "Meta'ya dönüşüm bildirimi bu piksele gönderilir.",
  },
  {
    key: "whatsappPhoneNumberId",
    label: "WhatsApp telefon numarası kimliği",
    short: "WhatsApp telefon numarası",
    hint: "Gelen WhatsApp mesajları bu numarayla eşleşir.",
  },
  {
    key: "whatsappBusinessId",
    label: "WhatsApp Business hesap kimliği",
    short: "WhatsApp Business hesabı",
    hint: "Telefon numarasının bağlı olduğu WhatsApp Business hesabı.",
  },
  {
    key: "pageId",
    label: "Facebook Sayfası kimliği",
    short: "Facebook Sayfası",
    hint: "Messenger mesajları ve Anında Form lead'leri bu sayfayla eşleşir.",
  },
  {
    key: "instaId",
    label: "Instagram hesap kimliği",
    short: "Instagram hesabı",
    hint: "Instagram DM mesajları bu hesapla eşleşir.",
  },
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

/** Yükleme hatası boş liste gibi gösterilmez (İÇ-3): ne olduğu + "Tekrar dene". */
function LoadError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <p className="font-medium">{title}</p>
      {message && <p className="mt-1">{message}</p>}
      <button type="button" className="secondary-button mt-3" onClick={onRetry}>
        Tekrar dene
      </button>
    </div>
  );
}

export default function MetaConnectionsPage() {
  const [conns, setConns] = useState<Conn[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [connsError, setConnsError] = useState<string | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [notice, setNotice] = useState<CallbackNotice | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [idForm, setIdForm] = useState<IdForm>({ pixelId: "", whatsappPhoneNumberId: "", whatsappBusinessId: "", pageId: "", instaId: "" });
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState<Conn | null>(null);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const [disconnectError, setDisconnectError] = useState("");

  async function load() {
    setLoading(true);
    setConnsError(null);
    setAccountsError(null);
    try {
      const data = await api<{ connections: Conn[] }>("/api/meta/connections");
      setConns(data.connections ?? []);
    } catch (e) {
      setConnsError(e instanceof Error ? e.message : "");
    }
    try {
      const a = await api<{ accounts: Account[] }>("/api/platforms/accounts");
      setAccounts(a.accounts ?? []);
    } catch (e) {
      setAccountsError(e instanceof Error ? e.message : "");
    }
    setLoading(false);
  }
  async function connect() {
    try {
      const data = await api<{ authUrl: string }>("/api/meta/oauth");
      window.location.href = data.authUrl;
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Meta bağlantısı başlatılamadı. Birkaç dakika sonra tekrar deneyin." });
    }
  }
  async function refresh(id: string) {
    try {
      const r = await api<{ connection: { status: string; expiresAt: string | null; refreshed: boolean } }>(
        "/api/meta/connections/" + id + "/refresh",
        "POST",
        {},
      );
      setMsg({ kind: "ok", text: `Meta bağlantısı yenilendi. Durum: ${metaConnectionStyle(r.connection.status).label}.` });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Meta bağlantısı yenilenemedi. Tekrar deneyin." });
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
      setMsg({ kind: "ok", text: "Varsayılan reklam hesabı güncellendi." });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Varsayılan hesap değiştirilemedi. Tekrar deneyin." });
    }
    load();
  }
  function askDisconnect(c: Conn) {
    setDisconnectError("");
    setDisconnecting(c);
  }
  async function disconnect() {
    if (!disconnecting) return;
    setDisconnectBusy(true);
    setDisconnectError("");
    try {
      const r = await api<{ connection: { id: string; status: string; adAccountsPaused: number } }>(
        "/api/meta/connections/" + disconnecting.id,
        "DELETE",
      );
      const paused = r.connection.adAccountsPaused;
      setDisconnecting(null);
      setMsg({
        kind: "ok",
        text: paused > 0 ? `Meta bağlantısı kesildi. ${paused} reklam hesabı duraklatıldı.` : "Meta bağlantısı kesildi.",
      });
      load();
    } catch (e) {
      // Hata diyaloğun içinde gösterilir; kullanıcı tekrar deneyebilir ya da vazgeçebilir.
      setDisconnectError(e instanceof Error ? e.message : "Meta bağlantısı kesilemedi. Tekrar deneyin.");
    } finally {
      setDisconnectBusy(false);
    }
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
      const names = r.changed
        .map((key) => ID_FIELDS.find((f) => f.key === key)?.short)
        .filter((name): name is string => Boolean(name));
      setMsg({
        kind: "ok",
        text:
          r.changed.length === 0
            ? "Değişiklik yapılmadı."
            : names.length > 0
              ? `Kimlik numaraları güncellendi: ${names.join(", ")}.`
              : "Kimlik numaraları güncellendi.",
      });
      setEditing(null);
      load();
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "Kimlik numaraları kaydedilemedi. Tekrar deneyin." });
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

  const noticeReason = notice?.reason ? notice.reason.replace(/[.\s]+$/, "") : null;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Meta bağlantıları"
        description="İşletme portföyünüzü, reklam hesaplarınızı, Facebook sayfalarınızı, Instagram ve WhatsApp Business hesaplarınızı bağlayın."
        crumbs={[{ label: "Ayarlar" }]}
        actions={<button type="button" onClick={connect} className="primary-button">Meta ile bağlantı kur</button>}
      />
      {notice && (
        <div
          role={notice.status === "connected" ? "status" : "alert"}
          className={`rounded-xl border p-3 text-sm ${notice.status === "connected" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}
        >
          {notice.status === "connected" ? (
            <div className="space-y-1">
              <p className="font-medium">
                Meta bağlantısı kuruldu.
                {notice.pages !== null && notice.pages > 0 ? ` ${notice.pages} sayfa bağlandı.` : ""}
                {notice.accounts !== null && notice.accounts > 0 ? ` ${notice.accounts} reklam hesabı bulundu.` : ""}
              </p>
              {notice.missing.length > 0 && (
                <p className="text-rose-700">
                  Eksik zorunlu izinler: {notice.missing.map(scopeLabel).join(", ")}. Kampanya ve lead işlemleri için Meta ile yeniden bağlanıp bu izinleri verin.
                </p>
              )}
              {notice.optional.length > 0 && (
                <p className="text-amber-800">
                  Eksik isteğe bağlı izinler: {notice.optional.map(scopeLabel).join(", ")}. Bu izinler olmadan mesajlaşma, Instagram ve WhatsApp özellikleri sınırlı çalışır.
                </p>
              )}
            </div>
          ) : (
            <p>
              Meta bağlantısı kurulamadı{noticeReason ? `: ${noticeReason}` : ""}. Tekrar denemek için “Meta ile bağlantı kur” düğmesini kullanın.
            </p>
          )}
        </div>
      )}
      {msg && (
        <div
          role={msg.kind === "ok" ? "status" : "alert"}
          className={`rounded-xl border p-3 text-sm ${msg.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}
        >
          {msg.text}
        </div>
      )}
      <Card>
        <SectionHeading title="Bağlantılar" description="Bağlı Meta hesapları, izinleri ve bağlantıların geçerlilik süresi." />
        {loading ? (
          <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" />
        ) : connsError !== null ? (
          <LoadError title="Meta bağlantıları yüklenemedi." message={connsError} onRetry={() => void load()} />
        ) : conns.length === 0 ? (
          <IntroPanel
            title="Henüz Meta bağlantısı yok"
            action={<button type="button" onClick={connect} className="primary-button">Meta ile bağlantı kur</button>}
          >
            Kampanya yayınlamak, lead almak ve mesajları yanıtlamak için Meta hesabınızı bağlayın. Bağlantı kurulduğunda
            reklam hesaplarınız, sayfalarınız ve izinleriniz burada listelenir.
          </IntroPanel>
        ) : (
          <div className="space-y-3">
            {conns.map((c) => {
              const broken = c.status === "EXPIRED" || c.status === "REVOKED";
              const left = daysLeft(c.expiresAt);
              const soon = !broken && left !== null && left <= 3;
              const status = metaConnectionStyle(c.status);
              // missingPermissions yalnızca zorunlu izinleri taşır; opsiyoneller verilen izin listesinden türetilir.
              const requiredMissing = c.missingPermissions.filter(isRequiredScope);
              const optionalMissing = c.scopes.length > 0
                ? optionalScopesMissing(c.scopes)
                : c.missingPermissions.filter((s) => !isRequiredScope(s));
              const isEditing = editing === c.id;
              return (
                <div key={c.id} className={`rounded-lg border p-3 ${broken ? "border-rose-300 bg-rose-50/40" : soon ? "border-amber-300 bg-amber-50/40" : "border-slate-200"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900">{TYPE_LABEL[c.type] ?? "Meta bağlantısı"}</p>
                      <p className="break-all text-xs text-muted">{c.name ?? c.metaAccountId ?? c.pageId ?? "—"}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <span className="text-xs text-muted">Bağlandı: {formatDay(c.createdAt)}</span>
                    </div>
                  </div>
                  <p className={`mt-2 text-xs ${broken ? "text-rose-700" : soon ? "text-amber-800" : "text-muted"}`}>
                    {broken
                      ? "Bu bağlantı kullanılamıyor. Meta ile yeniden bağlanın."
                      : c.expiresAt
                        ? `Geçerlilik: ${formatDay(c.expiresAt)} tarihine kadar (${left} gün kaldı).`
                        : "Süre sınırı yok (Meta'da erişim kaldırılana kadar geçerli)."}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {broken ? (
                      <button type="button" onClick={connect} className="primary-button">Meta ile yeniden bağlan</button>
                    ) : (
                      <button type="button" onClick={() => refresh(c.id)} className={soon ? "primary-button" : "secondary-button"}>
                        Bağlantıyı yenile
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => (isEditing ? setEditing(null) : startEdit(c))}
                      className="secondary-button"
                      aria-expanded={isEditing}
                    >
                      {isEditing ? "Vazgeç" : "Kimlik numaralarını düzenle"}
                    </button>
                    {!broken && (
                      <button type="button" onClick={() => askDisconnect(c)} className="secondary-button text-rose-700 hover:bg-rose-50">
                        Bağlantıyı kes
                      </button>
                    )}
                  </div>
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer font-medium text-slate-700">Kimlik numaraları</summary>
                    <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                      {ID_FIELDS.map((f) => (
                        <div key={f.key} className="flex min-w-0 gap-1">
                          <dt className="shrink-0 text-muted">{f.short}:</dt>
                          <dd className="min-w-0 break-all text-slate-700">{c[f.key] ?? "—"}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                  {requiredMissing.length > 0 && (
                    <p className="mt-2 text-xs text-rose-700">
                      Eksik zorunlu izinler: {requiredMissing.map(scopeLabel).join(", ")}
                    </p>
                  )}
                  {optionalMissing.length > 0 && (
                    <p className="mt-1 text-xs text-amber-800">
                      Eksik isteğe bağlı izinler: {optionalMissing.map(scopeLabel).join(", ")}
                    </p>
                  )}
                  {c.lastError && <p className="mt-1 text-xs text-rose-700">Son hata: {c.lastError}</p>}
                  {isEditing && (
                    <form onSubmit={saveIds} className="mt-3 grid gap-4 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-2">
                      <p className="text-xs text-muted sm:col-span-2">
                        Otomatik eşleme açılana kadar bu kimlik numaralarını elle girin. Boş bıraktığınız alan temizlenir.
                      </p>
                      {ID_FIELDS.map((f) => {
                        const hintId = `${c.id}-${f.key}-hint`;
                        return (
                          <div key={f.key} className="space-y-1">
                            <label className="field">
                              {f.label}
                              <input
                                value={idForm[f.key]}
                                onChange={(e) => setIdForm({ ...idForm, [f.key]: e.target.value })}
                                aria-describedby={hintId}
                                autoComplete="off"
                                spellCheck={false}
                              />
                            </label>
                            <p id={hintId} className="text-xs text-muted">{f.hint}</p>
                          </div>
                        );
                      })}
                      <div className="sm:col-span-2">
                        <button type="submit" disabled={saving} className="primary-button">
                          {saving ? "Kaydediliyor…" : "Kimlik numaralarını kaydet"}
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
        <SectionHeading title="Reklam hesapları" description="Meta işlemlerinde varsayılan hesap kullanılır." />
        {loading ? (
          <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" />
        ) : accountsError !== null ? (
          <LoadError title="Reklam hesapları yüklenemedi." message={accountsError} onRetry={() => void load()} />
        ) : accounts.length === 0 ? (
          <EmptyState message="Henüz reklam hesabı yok. Meta ile bağlandığınızda reklam hesaplarınız burada listelenir." />
        ) : (
          <div className="space-y-3">
            {accounts.map((a) => {
              const status = entityStatusStyle(a.status);
              return (
                <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium text-slate-900">
                      {a.name}
                      {a.isDefault && <span className="ml-2 text-xs font-normal text-muted">Varsayılan hesap</span>}
                    </p>
                    <p className="text-xs text-muted">
                      Meta hesap kimliği: {a.metaAccountId ?? "—"} · Para birimi: {a.currency}
                    </p>
                    <p className="text-xs text-muted">
                      {a.connection ? `Meta bağlantısı: ${metaConnectionStyle(a.connection.status).label}` : "Meta bağlantısı yok"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {!a.isDefault && (
                      <button type="button" onClick={() => setDefault(a.id)} className="secondary-button">Varsayılan yap</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={disconnecting !== null}
        title="Meta bağlantısı kesilsin mi?"
        description={
          <>
            <p>Meta bağlantısı kesilecek ve bağlı reklam hesapları duraklatılacak.</p>
            {disconnecting && (
              <p className="mt-2 text-muted">
                Bağlantı: {disconnecting.name ?? disconnecting.metaAccountId ?? "—"} ({TYPE_LABEL[disconnecting.type] ?? "Meta bağlantısı"}). Yeniden kullanmak için Meta ile yeniden bağlanmanız gerekir.
              </p>
            )}
          </>
        }
        confirmLabel="Bağlantıyı kes"
        busyLabel="Bağlantı kesiliyor…"
        tone="danger"
        busy={disconnectBusy}
        error={disconnectError || undefined}
        onConfirm={() => void disconnect()}
        onCancel={() => setDisconnecting(null)}
      />
    </div>
  );
}
