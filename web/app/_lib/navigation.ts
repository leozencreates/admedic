/**
 * Girişten sonra nereye gidileceği (ADR-0016 · Faz 1 madde 8). Saf modül: sunucu ve istemci kullanır.
 * - Hasta koordinatörü → Lead CRM (işi orada); diğer roller → Genel Bakış.
 * - `?next=` yalnızca uygulama içi göreli yolsa kabul edilir (açık yönlendirme engeli).
 */
export function homePathForRole(role: string | null | undefined): string {
  return role === "PATIENT_COORDINATOR" ? "/leads" : "/";
}

export function safeNextPath(next: string | null | undefined): string | null {
  if (typeof next !== "string" || next.length === 0 || next.length > 512) return null;
  // Yalnızca "/" ile başlayan, "//" veya "/\" ile başlamayan (protokolsüz dış adres) yollar.
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  if (/[\u0000-\u001f]/.test(next)) return null;
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/api/")) return null;
  return next;
}

export function loginPath(from?: string | null): string {
  const next = safeNextPath(from);
  return next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login";
}
