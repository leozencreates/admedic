"use client";
import { useEffect, useRef } from "react";
import { AudioLines, Loader, Mic, MicOff } from "lucide-react";
import type { AssistantUiState } from "./state";

/**
 * Asistan küresi (ADR-0028 §4). Etkin oturumda giriş/çıkış ses düzeyi `--va-level` (0–1) değişkenine yazılır; CSS
 * ölçek ve hale ile gösterir. Durum yalnızca renkle anlatılmaz: simge değişir ve görünür durum metni ayrıca vardır.
 * Hareket azaltma tercihinde döngü hiç çalışmaz ve CSS statik görünüme düşer.
 */
export function Orb({ state, getLevel, size = 24 }: { state: AssistantUiState; getLevel?: () => number; size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const animate = Boolean(getLevel) && (state === "listening" || state === "speaking" || state === "thinking");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--va-level", "0");
    if (!animate || !getLevel) return;
    let reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      reduce = false;
    }
    if (reduce) return;
    let frame = 0;
    let level = 0;
    const tick = () => {
      let raw = 0;
      try {
        raw = getLevel();
      } catch {
        raw = 0;
      }
      const target = Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0));
      // Yumuşatma: ani sıçrama yerine kısa geçiş.
      level += (target - level) * 0.35;
      el.style.setProperty("--va-level", level.toFixed(3));
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [animate, getLevel]);

  const Icon =
    state === "speaking"
      ? AudioLines
      : state === "connecting" || state === "consent" || state === "thinking"
        ? Loader
        : state === "error" || state === "disabled"
          ? MicOff
          : Mic;

  return (
    <span ref={ref} className="va-orb" data-state={state} aria-hidden="true">
      <span className="va-orb__halo" />
      <span className="va-orb__core">
        <Icon size={size} strokeWidth={1.75} aria-hidden="true" className={Icon === Loader ? "va-orb__spin" : undefined} />
      </span>
    </span>
  );
}
