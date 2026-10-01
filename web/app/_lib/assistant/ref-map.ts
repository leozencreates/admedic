/**
 * Sesli asistan kayıt ref'leri (ADR-0028 §2 "Rol ve tenant"). Ajana gerçek veritabanı kimliği gönderilmez; okuma
 * araçları her kayda oturum içinde kısa bir ref verir (`c1`, `l3` …). Kimlik isteyen araçlar yalnızca bu ref'i alır ve
 * burada çözer; ajan kimlik uyduramaz, başka türün ref'ini (kampanya yerine lead) kullanamaz.
 *
 * Saf modül; eşleme yalnızca tarayıcı belleğinde, tek konuşma boyunca yaşar.
 */

export type RefKind = "campaign" | "lead" | "alert" | "recommendation" | "decision" | "studio" | "experiment";

const PREFIX: Record<RefKind, string> = {
  campaign: "c",
  lead: "l",
  alert: "a",
  recommendation: "r",
  decision: "d",
  studio: "s",
  experiment: "e",
};

const KIND_LABEL: Record<RefKind, string> = {
  campaign: "kampanya",
  lead: "lead",
  alert: "uyarı",
  recommendation: "öneri",
  decision: "karar",
  studio: "reklam taslağı",
  experiment: "A/B testi",
};

/** Ref biçimi: tür harfi + sayı. Serbest metin taşıyamaz. */
export const REF_PATTERN = /^[a-z][0-9]{1,5}$/;

/** Bir konuşmada en çok bu kadar kayıt eşlenir (bellek sınırı; aşılınca en eski eşlemeler düşer). */
const MAX_ENTRIES = 2000;

/** Ref çözülemediğinde; ileti ajana olduğu gibi gider (Türkçe, kimlik içermez). */
export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefError";
  }
}

export class RefMap {
  private readonly byRef = new Map<string, { kind: RefKind; id: string }>();
  private readonly byId = new Map<string, string>();
  private readonly counters: Record<RefKind, number> = { campaign: 0, lead: 0, alert: 0, recommendation: 0, decision: 0, studio: 0, experiment: 0 };

  /** Kaydın ref'i; aynı kayıt için hep aynı ref döner. */
  ref(kind: RefKind, id: string): string {
    const key = `${kind}:${id}`;
    const existing = this.byId.get(key);
    if (existing) return existing;
    if (this.byRef.size >= MAX_ENTRIES) {
      const oldest = this.byRef.keys().next().value as string;
      const entry = this.byRef.get(oldest)!;
      this.byRef.delete(oldest);
      this.byId.delete(`${entry.kind}:${entry.id}`);
    }
    this.counters[kind] += 1;
    const ref = `${PREFIX[kind]}${this.counters[kind]}`;
    this.byRef.set(ref, { kind, id });
    this.byId.set(key, ref);
    return ref;
  }

  /** Daha önce eşlenmişse kaydın ref'i (yeni ref üretmez). */
  existingRef(kind: RefKind, id: string): string | null {
    return this.byId.get(`${kind}:${id}`) ?? null;
  }

  /** Ref → gerçek kimlik. Bilinmeyen, biçimsiz ya da başka türün ref'i Türkçe hata fırlatır. */
  resolve(ref: unknown, kind: RefKind): string {
    const label = KIND_LABEL[kind];
    if (typeof ref !== "string" || !REF_PATTERN.test(ref))
      throw new RefError(`Geçersiz ${label} referansı. Önce listeyi okuyup oradaki referansı kullanın.`);
    const entry = this.byRef.get(ref);
    if (!entry)
      throw new RefError(`Bu ${label} referansı bu konuşmada bulunamadı. Önce listeyi yeniden okuyun.`);
    if (entry.kind !== kind)
      throw new RefError(`Bu referans bir ${KIND_LABEL[entry.kind]} kaydına ait; ${label} referansı gerekiyor.`);
    return entry.id;
  }

  get size(): number {
    return this.byRef.size;
  }

  clear(): void {
    this.byRef.clear();
    this.byId.clear();
    for (const kind of Object.keys(this.counters) as RefKind[]) this.counters[kind] = 0;
  }
}

export function createRefMap(): RefMap {
  return new RefMap();
}
