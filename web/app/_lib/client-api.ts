export async function api<T>(
  url: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers:
      data === undefined ? undefined : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "İşlem başarısız.");
  return result as T;
}
export const labels: Record<string, string> = {
  DRAFT: "Taslak",
  IN_REVIEW: "Onay bekliyor",
  APPROVED: "Onaylandı",
  REJECTED: "Düzeltme gerekli",
  RUNNING: "Veri toplanıyor",
  COMPLETED: "Tamamlandı",
};
