import { describe, expect, it } from "vitest";
import { dictionaries, t } from "../app/_lib/i18n";
import {
  INITIAL_LIVE,
  PENDING_ANNOUNCE_AT,
  STATE_LABEL_KEY,
  TRANSCRIPT_LIMIT,
  CONFIRM_ARM_MS,
  appendLine,
  consentStorageKey,
  countdownMilestone,
  deriveUiState,
  isActiveState,
  listeningAnnounceDelayMs,
  isToggleShortcut,
  parsePendingResult,
  pendingContextUpdate,
  readConsent,
  reduceLive,
  remainingSeconds,
  pendingSurface,
  pendingTotalSeconds,
  SCREEN_ANNOUNCE_DELAY_MS,
  screenClickAllowed,
  screenConfirmLabelKey,
  screenConfirmTarget,
  shouldFocusCard,
  showsTextInput,
  writeConsent,
  type AssistantUiState,
  type LiveEvent,
  type LiveRegions,
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

describe("yazı kutusu yalnızca oturum varken", () => {
  it("başlatma reddedilince (ör. günlük sınır 429) ya da hatayla bitince gösterilmez", () => {
    expect(showsTextInput("error")).toBe(false);
    for (const phase of ["idle", "consent", "disabled"] as const) expect(showsTextInput(phase), phase).toBe(false);
    for (const phase of ["permission", "connecting", "active"] as const) expect(showsTextInput(phase), phase).toBe(true);
  });
});

describe("canlı bölgeler: ajan yanıtı durum metniyle ezilmez", () => {
  const listening = { type: "state", state: "listening", text: "Dinliyorum…" } as const;
  const thinking = { type: "state", state: "thinking", text: "Düşünüyor…" } as const;
  const run = (events: LiveEvent[], from: LiveRegions = INITIAL_LIVE) => events.reduce(reduceLive, from);

  it("bağlanınca durumlar duyurulur", () => {
    const live = run([{ type: "state", state: "connecting", text: "Bağlanıyor…" }, listening]);
    expect(live.status).toBe("Dinliyorum…");
  });

  it("bağlanırken gelen açılış selamından sonra ilk 'Dinliyorum…' hemen duyurulur; selam ileti bölgesinde kalır", () => {
    const connecting = { type: "state", state: "connecting", text: "Bağlanıyor…" } as const;
    const live = run([connecting, { type: "reply", text: "Asistan: Merhaba." }, listening]);
    expect(live).toMatchObject({ status: "Dinliyorum…", message: "Asistan: Merhaba.", deferredStatus: null, listenedSinceConnect: true });
    // Yeniden bağlanınca yine bir kez duyurulur.
    const again = run([{ type: "status", text: "Sesli asistan kapandı." }, connecting, { type: "reply", text: "Asistan: Merhaba." }, listening], live);
    expect(again.status).toBe("Dinliyorum…");
  });

  it("yanıttan sonraki 'Dinliyorum…' ertelenir: ne yanıtı ne durum bölgesini hemen değiştirir, okuma süresi dolunca bir kez duyurulur", () => {
    const afterReply = run([listening, thinking, { type: "reply", text: "Asistan: 2 kampanya var." }]);
    expect(afterReply.message).toBe("Asistan: 2 kampanya var.");
    expect(afterReply.status).toBe("");
    // Konuşma bitince dinlemeye dönmek hemen duyurulmaz; yalnızca ertelenir.
    const next = run([listening, { type: "state", state: "speaking", text: "Konuşuyor…" }, listening], afterReply);
    expect(next).toMatchObject({ status: "", message: "Asistan: 2 kampanya var.", deferredStatus: "Dinliyorum…" });
    expect(next.messageSeq).toBe(afterReply.messageSeq);
    // Okuma süresi doldu: durum bölgesine bir kez yazılır, ileti bölgesi aynı kalır.
    const flushed = reduceLive(next, { type: "flush" });
    expect(flushed).toMatchObject({ status: "Dinliyorum…", message: "Asistan: 2 kampanya var.", deferredStatus: null });
    expect(reduceLive(flushed, { type: "flush" })).toBe(flushed);
    expect(reduceLive(flushed, listening)).toBe(flushed);
  });

  it("ertelenen 'Dinliyorum…' kullanıcı yeniden konuşunca ya da durum değişince düşer", () => {
    const deferred = run([listening, thinking, { type: "reply", text: "Tamam." }, listening]);
    expect(deferred.deferredStatus).toBe("Dinliyorum…");
    const typed = run([thinking, { type: "flush" }], deferred);
    expect(typed).toMatchObject({ status: "Düşünüyor…", deferredStatus: null });
    const spoke = run([{ type: "state", state: "speaking", text: "Konuşuyor…" }, { type: "flush" }], deferred);
    expect(spoke).toMatchObject({ status: "", deferredStatus: null });
    const closed = run([{ type: "status", text: "Sesli asistan kapandı." }, { type: "flush" }], deferred);
    expect(closed).toMatchObject({ status: "Sesli asistan kapandı.", deferredStatus: null });
    // Yeni bir yanıt bekleyen duyuruyu sıfırlar (süre yeni yanıta göre yeniden başlar).
    expect(reduceLive(deferred, { type: "reply", text: "Bir şey daha." }).deferredStatus).toBeNull();
  });

  it("okuma süresi yanıt uzunluğuyla artar, 1,5–8 sn arasında kalır", () => {
    expect(listeningAnnounceDelayMs("")).toBe(1_500);
    expect(listeningAnnounceDelayMs("Tamam.")).toBe(1_500);
    expect(listeningAnnounceDelayMs("x".repeat(50))).toBe(4_000);
    expect(listeningAnnounceDelayMs("x".repeat(1_000))).toBe(8_000);
    expect(listeningAnnounceDelayMs("x".repeat(60))).toBeGreaterThan(listeningAnnounceDelayMs("x".repeat(30)));
  });

  it("kullanıcı yeniden konuşunca 'Düşünüyor…' yeniden duyurulur", () => {
    const live = run([listening, thinking, { type: "reply", text: "Tamam." }, listening, thinking]);
    expect(live.status).toBe("Düşünüyor…");
    expect(live.quietListening).toBe(false);
  });

  it("aynı yanıt art arda gelse de yeniden duyurulur (düğüm anahtarı artar); boş yanıt yok sayılır", () => {
    const a = run([{ type: "reply", text: "Tamam." }]);
    const b = reduceLive(a, { type: "reply", text: "Tamam." });
    expect(b.messageSeq).toBe(a.messageSeq + 1);
    expect(reduceLive(b, { type: "reply", text: "  " })).toBe(b);
  });

  it("kart duyurusu ileti bölgesine, oturum iletisi durum bölgesine gider", () => {
    const live = run([listening, { type: "message", text: "Onay için 10 saniye kaldı." }]);
    expect(live).toMatchObject({ status: "Dinliyorum…", message: "Onay için 10 saniye kaldı." });
    const ended = reduceLive(live, { type: "status", text: "Sesli asistan kapandı." });
    expect(ended.status).toBe("Sesli asistan kapandı.");
    expect(ended.message).toBe(live.message);
  });

  it("başka durumlar (konuşuyor, hata, boşta) duyurulmaz", () => {
    for (const state of ["speaking", "error", "idle", "consent", "disabled"] as const)
      expect(reduceLive(INITIAL_LIVE, { type: "state", state, text: "x" })).toBe(INITIAL_LIVE);
  });
});

describe("onay kartı (Faz 3)", () => {
  it("kalan saniye yukarı yuvarlanır, eksiye düşmez", () => {
    expect(remainingSeconds(60_000, 0)).toBe(60);
    expect(remainingSeconds(60_000, 59_001)).toBe(1);
    expect(remainingSeconds(60_000, 70_000)).toBe(0);
  });

  it("geri sayım yalnızca eşiklerde ve her eşikte bir kez duyurulur", () => {
    expect(PENDING_ANNOUNCE_AT).toEqual([30, 10]);
    let last: number | null = null;
    const announced: number[] = [];
    for (let s = 60; s >= 0; s--) {
      const m = countdownMilestone(s, last);
      if (m !== null) {
        announced.push(s);
        last = m;
      }
    }
    expect(announced).toEqual([30, 10]);
  });

  it("sekme uyuyup eşikler atlanırsa yalnızca en küçüğü duyurulur; 0'da duyuru yok", () => {
    expect(countdownMilestone(5, null)).toBe(10);
    expect(countdownMilestone(5, 10)).toBeNull();
    expect(countdownMilestone(0, null)).toBeNull();
    expect(countdownMilestone(45, null)).toBeNull();
  });

  it("odak yalnızca gövdeden ya da asistanın içinden kart kabına taşınır; sayfadaki öğeden ve yazma alanından çalınmaz", () => {
    const base = { activeIsBody: false, activeInAssistant: false, activeIsEditable: false, cardHasFocus: false };
    expect(shouldFocusCard({ ...base, activeIsBody: true })).toBe(true);
    // Yüzen düğme ya da paneldeki "Bitir" düğmesi.
    expect(shouldFocusCard({ ...base, activeInAssistant: true })).toBe(true);
    // Sayfadaki bağlantı/düğme: odak asistan dışından çalınmaz.
    expect(shouldFocusCard(base)).toBe(false);
    // Panelin metin kutusu ya da sayfadaki bir yazma alanı.
    expect(shouldFocusCard({ ...base, activeInAssistant: true, activeIsEditable: true })).toBe(false);
    expect(shouldFocusCard({ ...base, activeIsEditable: true })).toBe(false);
    // Kart odaktayken eylem değişti: odak kart kabına alınır.
    expect(shouldFocusCard({ ...base, activeInAssistant: true, cardHasFocus: true })).toBe(true);
    expect(CONFIRM_ARM_MS).toBeGreaterThanOrEqual(500);
  });

  it("araç sonucundan yalnızca bilinen sabit hata iletisi ajana aktarılır", () => {
    expect(parsePendingResult(JSON.stringify({ ok: true, message: "x" }))).toEqual({ ok: true });
    expect(parsePendingResult(JSON.stringify({ ok: false, error: "Bu işlem şu an uygulanamıyor: policy_warning" }))).toEqual({
      ok: false,
      error: "Bu işlem şu an uygulanamıyor: policy_warning",
    });
    expect(parsePendingResult(JSON.stringify({ ok: false, error: "Bu işlem için yetkiniz yok." }), ["Bu işlem için yetkiniz yok."])).toEqual({
      ok: false,
      error: "Bu işlem için yetkiniz yok.",
    });
    // Sunucudan sızabilecek serbest metin (ör. hasta adı) atılır.
    expect(parsePendingResult(JSON.stringify({ ok: false, error: "Ayşe Yılmaz bulunamadı" }))).toEqual({ ok: false });
    expect(parsePendingResult("bozuk")).toEqual({ ok: false });
  });

  it("ajana giden bağlam iletisi kısa ve kimliksizdir", () => {
    for (const outcome of ["confirmed", "failed", "cancelled", "expired"] as const) {
      const text = pendingContextUpdate(outcome, "update_alert");
      expect(text).toContain("(update_alert)");
      expect(text.length).toBeLessThan(220);
      expect(text).not.toMatch(/p_[0-9a-f]{32}/);
    }
    expect(pendingContextUpdate("failed", "update_alert", "Bu işlem şu an uygulanamıyor: monthly_cap")).toContain("monthly_cap");
    // Geçersiz araç adı metne girmez.
    expect(pendingContextUpdate("cancelled", "Ayşe <script>")).not.toContain("Ayşe");
  });

  it("ekrandan onaylanınca aracın temizlenmiş sonucu (ref, varyantlar) ajana iletilir; başarısız/bozuk sonuç iletilmez", () => {
    const saved = JSON.stringify({ ok: true, ref: "s1", status: "DRAFT", policyRisk: "LOW" });
    const text = pendingContextUpdate("confirmed", "save_studio_draft", undefined, saved);
    expect(text).toContain('"ref":"s1"');
    expect(text).toContain("(save_studio_draft)");
    const copy = JSON.stringify({ ok: true, variants: [{ headline: "Başlık A", text: "Gövde", cta: "LEARN_MORE" }] });
    expect(pendingContextUpdate("confirmed", "generate_ad_copy", undefined, copy)).toContain("Başlık A");
    const plain = pendingContextUpdate("confirmed", "update_alert");
    expect(pendingContextUpdate("confirmed", "update_alert", undefined, JSON.stringify({ ok: false, error: "x" }))).toBe(plain);
    expect(pendingContextUpdate("confirmed", "update_alert", undefined, "bozuk")).toBe(plain);
    expect(pendingContextUpdate("confirmed", "update_alert", undefined, "[1,2]")).toBe(plain);
    expect(pendingContextUpdate("confirmed", "update_alert", undefined, JSON.stringify({ ok: true, big: "x".repeat(5000) }))).toBe(plain);
    // Sonuç yalnızca onayda eklenir.
    expect(pendingContextUpdate("cancelled", "save_studio_draft", undefined, saved)).not.toContain("s1");
  });

  it("kartın tr ve en metinleri vardır; düğmeler Onayla/Vazgeç", () => {
    for (const key of [
      "assistant.pending.title",
      "assistant.pending.confirm",
      "assistant.pending.cancel",
      "assistant.pending.expires",
      "assistant.pending.remaining",
      "assistant.pending.applying",
      "assistant.pending.announce",
      "assistant.pending.typeHint",
      "assistant.pending.shown",
      "assistant.pending.replaced",
      "assistant.pending.failed",
    ] as const) {
      expect(dictionaries.tr[key]).toBeTruthy();
      expect(dictionaries.en[key]).toBeTruthy();
    }
    expect(t("assistant.pending.confirm", "tr")).toBe("Onayla");
    expect(t("assistant.pending.cancel", "tr")).toBe("Vazgeç");
    expect(dictionaries.tr["assistant.pending.remaining"]).toContain("{seconds}");
    expect(dictionaries.tr["assistant.pending.announce"]).toContain("{summary}");
    expect(dictionaries.tr["assistant.pending.replaced"]).toContain("{summary}");
    // Kart açılış duyurusu özeti tekrar etmez (özeti ajan yanıtı okur).
    expect(dictionaries.tr["assistant.pending.shown"]).not.toContain("{summary}");
  });
});

describe("ekran onay penceresi (Faz 4, R2/R3)", () => {
  const confirmation = (risk: "R2" | "R3") => ({ title: "x", fields: [], risk, riskLabel: "y" });
  const r1 = { pendingId: "p_1", risk: "R1" as const };
  const r2 = { pendingId: "p_2", risk: "R2" as const, confirmation: confirmation("R2") };
  const r3 = { pendingId: "p_3", risk: "R3" as const, confirmation: confirmation("R3") };

  it("R1 kartta, R2/R3 yalnızca eşleşen ekran görünümüyle pencerede; görünümsüz R2/R3 hiçbir yerde onaylanamaz", () => {
    expect(pendingSurface(null)).toBeNull();
    expect(pendingSurface(r1)).toBe("card");
    expect(pendingSurface(r2)).toBe("dialog");
    expect(pendingSurface(r3)).toBe("dialog");
    expect(pendingSurface({ risk: "R2" })).toBe("none");
    expect(pendingSurface({ risk: "R3", confirmation: confirmation("R2") })).toBe("none");
  });

  it("geri sayım toplamı risk seviyesinin süresidir (R1 60 sn, R2/R3 120 sn)", () => {
    expect(pendingTotalSeconds("R1")).toBe(60);
    expect(pendingTotalSeconds("R2")).toBe(120);
    expect(pendingTotalSeconds("R3")).toBe(120);
  });

  it("R3 onay düğmesi ne onaylandığını açıkça söyler; iki dilde de anahtar var", () => {
    expect(t(screenConfirmLabelKey("R3"), "tr")).toBe("Harcamayı onayla");
    expect(t(screenConfirmLabelKey("R2"), "tr")).toBe("Onayla");
    for (const key of [screenConfirmLabelKey("R2"), screenConfirmLabelKey("R3")]) {
      expect(dictionaries.en[key]).toBeTruthy();
      expect(dictionaries.en[key]).not.toBe(dictionaries.tr[key]);
    }
  });

  it("tıklama yalnızca gerçek (isTrusted), etkin düğmede başlamış ve işlem sürmüyorken kabul edilir", () => {
    const ok = { trusted: true, armed: true, busy: false, fromPointer: true, pressStartedArmed: true };
    expect(screenClickAllowed(ok)).toBe(true);
    // Betikle üretilen tıklama (ajan ya da sayfa betiği `click()`): reddedilir.
    expect(screenClickAllowed({ ...ok, trusted: false })).toBe(false);
    // Pencere yeni açıldı: ilk CONFIRM_ARM_MS içinde reddedilir.
    expect(CONFIRM_ARM_MS).toBeGreaterThanOrEqual(1000);
    expect(screenClickAllowed({ ...ok, armed: false })).toBe(false);
    expect(screenClickAllowed({ ...ok, busy: true })).toBe(false);
    // Basış düğme etkinleşmeden başladı, sonra bırakıldı: reddedilir.
    expect(screenClickAllowed({ ...ok, pressStartedArmed: false })).toBe(false);
    // Klavyeyle (Enter/Boşluk; `detail` 0) bilerek "Onayla"ya geçen kullanıcı onaylayabilir.
    expect(screenClickAllowed({ ...ok, fromPointer: false, pressStartedArmed: false })).toBe(true);
    expect(screenClickAllowed({ ...ok, fromPointer: false, armed: false })).toBe(false);
  });

  it("üst bileşen: yalnızca pencerenin gösterdiği, hâlâ bekleyen ve çözülmeyen ekran eylemi onaylanır", () => {
    const base = { clickedId: "p_2", current: r2, resolvingId: null, trusted: true };
    expect(screenConfirmTarget(base)).toBe(true);
    expect(screenConfirmTarget({ ...base, trusted: false })).toBe(false);
    expect(screenConfirmTarget({ ...base, current: null })).toBe(false);
    // Pencere bu arada başka bir eyleme geçti: eski tıklama yok sayılır.
    expect(screenConfirmTarget({ ...base, current: r3 })).toBe(false);
    // Çift tıklama: aynı eylem zaten çözülüyor.
    expect(screenConfirmTarget({ ...base, resolvingId: "p_2" })).toBe(false);
    // R1 eylemi pencereden onaylanmaz (kartın yolu), görünümsüz R2 de.
    expect(screenConfirmTarget({ ...base, clickedId: "p_1", current: r1 })).toBe(false);
    expect(screenConfirmTarget({ ...base, current: { pendingId: "p_2", risk: "R2" } })).toBe(false);
  });

  it("pencere kapanırken yapılan duyuru kısa süre bekletilir (açıkken sayfa inert)", () => {
    expect(SCREEN_ANNOUNCE_DELAY_MS).toBeGreaterThan(0);
    expect(SCREEN_ANNOUNCE_DELAY_MS).toBeLessThan(1000);
  });

  it("pencere metinleri iki dilde de tanımlı", () => {
    for (const key of [
      "assistant.screen.riskPrefix",
      "assistant.screen.warningPrefix",
      "assistant.screen.voiceHint",
      "assistant.screen.expires",
      "assistant.screen.arming",
      "assistant.screen.before",
      "assistant.screen.after",
    ] as const) {
      expect(dictionaries.tr[key]).toBeTruthy();
      expect(dictionaries.en[key]).toBeTruthy();
    }
    expect(t("assistant.screen.expires", "tr")).toContain("{seconds}");
    expect(t("assistant.screen.expires", "en")).toContain("{seconds}");
  });
});
