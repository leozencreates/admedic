/**
 * Benzersizlik ihlali (P2002) sütunları. Yerel motor `meta.target` doldurur; Rust'sız istemci + sürücü
 * bağdaştırıcısı (ADR-0023) ise sütunları yalnızca `meta.driverAdapterError.cause.constraint` içinde taşır.
 * İkisini de okur; sütun adlarındaki tırnaklar atılır. P2002 değilse `null`, sütunlar bilinmiyorsa `[]`.
 */
export function uniqueViolationFields(error: unknown): string[] | null {
  const e = error as {
    code?: unknown;
    meta?: {
      target?: unknown;
      driverAdapterError?: { cause?: { constraint?: { fields?: unknown; index?: unknown } } };
    };
  } | null;
  if (!e || e.code !== "P2002") return null;
  const clean = (v: unknown) => String(v).replace(/"/g, "");
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.map(clean);
  if (typeof target === "string") return [clean(target)];
  const constraint = e.meta?.driverAdapterError?.cause?.constraint;
  if (Array.isArray(constraint?.fields)) return constraint.fields.map(clean);
  if (typeof constraint?.index === "string") return [clean(constraint.index)];
  return [];
}
