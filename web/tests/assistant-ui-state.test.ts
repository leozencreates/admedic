import { describe, expect, it } from "vitest";
import { dictionaries, t } from "../app/_lib/i18n";
import {
  STATE_LABEL_KEY,
  TRANSCRIPT_LIMIT,
  appendLine,
  consentStorageKey,
  deriveUiState,
  isActiveState,
  isToggleShortcut,
  readConsent,
  writeConsent,
  type AssistantUiState,
  type TranscriptLine,
} from "../app/_components/voice-assistant/state";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("sesli asistan arayüz durumu (ADR-0028 §4)", () => {
  it("aşama, bağlantı durumu ve kipten görünen durumu türetir", () => {
    const base = { status: "disconnected", mode: "listening", thinking: false } as const;
    expect(deriveUiState({ ...base, phase: "idle" })).toBe("idle");
    expect(deriveUiState({ ...base, phase: "consent" })).toBe("consent");
    expect(deriveUiState({ ...base, phase: "permission" })).toBe("consent");
    expect(deriveUiState({ ...base, phase: "connecting" })).toBe("connecting");
    expect(deriveUiState({ ...base, phase: "disabled" })).toBe("disabled");
    expect(deriveUiState({ ...base, phase: "error" })).toBe("error");
    expect(deriveUiState({ ...base, phase: "active", status: "error" })).toBe("error");
    expect(deriveUiState({ ...base, phase: "active", status: "connecting" })).toBe("connecting");
    expect(deriveUiState({ ...base, phase: "active", status: "connected" })).toBe("listening");
    expect(deriveUiState({ ...base, phase: "active", status: "connected", thinking: true })).toBe("thinking");
    expect(deriveUiState({ ...base, phase: "active", status: "connected", mode: "speaking", thinking: true })).toBe("speaking");
  });

  it("her durumun tr ve en görünür metni vardır", () => {
    for (const state of Object.keys(STATE_LABEL_KEY) as AssistantUiState[]) {
      const key = STATE_LABEL_KEY[state];
      expect(dictionaries.tr[key]).toBeTruthy();
      expect(dictionaries.en[key]).toBeTruthy();
    }
    expect(t("assistant.state.listening", "tr")).toBe("Dinliyorum…");
    expect(t("assistant.state.disabled", "tr")).toBe("Devre dışı");
  });

  it("asistan adı sözlüğe yazılmaz; yer tutucu kullanılır", () => {
    for (const lang of ["tr", "en"] as const) {
      expect(dictionaries[lang]["assistant.name"]).toContain("{name}");
      expect(dictionaries[lang]["assistant.consent.intro"]).toContain("{name}");
    }
  });

  it("yalnızca açık ya da açılan oturum 'basılı' sayılır", () => {
    expect(isActiveState("idle")).toBe(false);
    expect(isActiveState("consent")).toBe(false);
    expect(isActiveState("error")).toBe(false);
    expect(isActiveState("connecting")).toBe(true);
    expect(isActiveState("speaking")).toBe(true);
  });

  it("izin kullanıcı başına tutulur, anahtar kullanıcı bilgisini düz taşımaz", () => {
    const storage = memoryStorage();
    expect(readConsent(storage, "usr_ayse")).toBe(false);
    writeConsent(storage, "usr_ayse");
    expect(readConsent(storage, "usr_ayse")).toBe(true);
    expect(readConsent(storage, "usr_mehmet")).toBe(false);
    const key = consentStorageKey("usr_ayse");
    expect(key).not.toContain("usr_ayse");
    expect([...storage.map.keys()]).toEqual([key]);
  });

  it("kullanıcı kimliği bilinmiyorsa izin paylaşılan bir anahtara yazılmaz ve okunmaz", () => {
    const storage = memoryStorage();
    expect(consentStorageKey(null)).toBeNull();
    expect(consentStorageKey("  ")).toBeNull();
    writeConsent(storage, null);
    writeConsent(storage, undefined);
    expect(storage.map.size).toBe(0);
    storage.map.set("assistant-consent:v1:anon", "1");
    expect(readConsent(storage, null)).toBe(false);
    expect(readConsent(storage, "")).toBe(false);
  });

  it("depolama hata verirse izin yok sayılır ve yazma fırlatmaz", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(readConsent(broken, "x")).toBe(false);
    expect(() => writeConsent(broken, "x")).not.toThrow();
    expect(readConsent(null, "x")).toBe(false);
  });

  it("konuşma satırları sınırlı tutulur", () => {
    let lines: TranscriptLine[] = [];
    for (let i = 1; i <= TRANSCRIPT_LIMIT + 5; i++) lines = appendLine(lines, { id: i, role: "user", text: String(i) });
    expect(lines).toHaveLength(TRANSCRIPT_LIMIT);
    expect(lines[0].id).toBe(6);
  });

  it("kısayol yalnızca Ctrl+Shift+Boşluk", () => {
    const k = { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: "Space" };
    expect(isToggleShortcut(k)).toBe(true);
    expect(isToggleShortcut({ ...k, shiftKey: false })).toBe(false);
    expect(isToggleShortcut({ ...k, metaKey: true })).toBe(false);
    expect(isToggleShortcut({ ...k, code: "KeyK" })).toBe(false);
  });
});
