"use client";
import type { Ref } from "react";
import { Orb } from "./orb";
import type { AssistantUiState } from "./state";

/**
 * Yüzen asistan düğmesi (ADR-0028 §4): `aria-pressed` oturumun açık olup olmadığını, `aria-label` durumu ve basınca ne
 * olacağını söyler. En az 44 px dokunma alanı; odak halkası `:focus-visible` ile görünür.
 */
export function AssistantButton({
  ref,
  state,
  pressed,
  label,
  stateText,
  getLevel,
  controls,
  unavailable = false,
  onClick,
}: {
  ref?: Ref<HTMLButtonElement>;
  state: AssistantUiState;
  pressed: boolean;
  label: string;
  stateText: string;
  getLevel?: () => number;
  controls?: string;
  /**
   * Aydınlatma diyaloğu açıkken basmanın etkisi yoktur. Yerel `disabled` kullanılmaz: odaklı düğme devre dışı kalınca
   * tarayıcı odağı gövdeye düşürür (mikrofon izni sırasında da düğme etkin kalır; basmak başlatmayı iptal eder).
   */
  unavailable?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className="va-fab"
      data-state={state}
      aria-pressed={pressed}
      aria-label={label}
      aria-controls={controls}
      aria-keyshortcuts="Control+Shift+Space"
      aria-disabled={unavailable || undefined}
      onClick={() => {
        if (!unavailable) onClick();
      }}
    >
      <Orb state={state} getLevel={getLevel} />
      {/* Görünür durum metni (renk tek başına bilgi taşımaz, ADR-0021); düğmenin adı aria-label'dadır. */}
      <span className="va-fab__state" aria-hidden="true">
        {stateText}
      </span>
    </button>
  );
}
