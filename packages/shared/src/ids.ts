import { createHash, randomUUID } from "crypto";

export function uid(): string {
  return randomUUID();
}

export function shortId(prefix = ""): string {
  const rnd = randomUUID().replace(/-/g, "").slice(0, 10);
  return `${prefix}${rnd}`;
}

/** Deterministik donanımımsı RNG (mulberry32) — test ve mock veri için. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** String'i sayısal tohum yapar (küçük/hukuk için). */
export function seedFromString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}