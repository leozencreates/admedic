// ADR-0025: kabuk, sunucudaki web panelini saran ince istemcidir.
// Bu ekran yalnızca sunucu adresini sorar, sağlık ucunu yoklar ve paneli açar; iş mantığı ve veri burada yoktur.
// Kullanıcı girdisi ya da sunucu yanıtı innerHTML ile yazılmaz; tüm çıktı textContent ile üretilir.
import { normalizeServerUrl, readHealth } from "./server-url.js";

const SERVER_KEY = "server-url";
const HEALTH_TIMEOUT_MS = 8000;
// Telefonda menü çubuğu yoktur; adres değiştirme düğmesi görülebilsin diye bağlantı ekranı kısa süre bekler.
const MOBILE_GRACE_MS = 1500;
const $ = (sel) => document.querySelector(sel);

const TEXT = {
  tr: {
    connectingTitle: "Bağlanılıyor",
    change: "Sunucu adresini değiştir",
    setupTitle: "Sunucuya bağlan",
    setupHint: "Panelin çalıştığı sunucunun adresini girin. Adresi yöneticinizden alabilirsiniz.",
    label: "Sunucu adresi",
    connect: "Bağlan",
    checking: "Sunucu yoklanıyor…",
    empty: "Sunucu adresini yazın.",
    invalid: "Adres geçerli değil. Örnek: https://panel.ornek.com",
    insecure: "Uzak sunucu adresi https:// ile başlamalı.",
    unreachable: "Sunucuya ulaşılamadı. Adresi ve internet bağlantınızı denetleyin.",
    down: "Sunucu yanıt veriyor ama veritabanına ulaşamıyor. Biraz sonra yeniden deneyin.",
    unknown: "Bu adreste panel bulunamadı. Adresi denetleyin.",
  },
  en: {
    connectingTitle: "Connecting",
    change: "Change server address",
    setupTitle: "Connect to server",
    setupHint: "Enter the address of the server that runs the panel. Your administrator can give you the address.",
    label: "Server address",
    connect: "Connect",
    checking: "Checking the server…",
    empty: "Enter the server address.",
    invalid: "The address is not valid. Example: https://panel.example.com",
    insecure: "A remote server address must start with https://.",
    unreachable: "Could not reach the server. Check the address and your internet connection.",
    down: "The server responds but cannot reach its database. Try again shortly.",
    unknown: "No panel was found at this address. Check the address.",
  },
};
const lang = /^en\b/i.test(navigator.language || "") ? "en" : "tr";
const text = (key) => TEXT[lang][key];

function readSaved() {
  try {
    return localStorage.getItem(SERVER_KEY) || "";
  } catch {
    return "";
  }
}
function save(origin) {
  try {
    localStorage.setItem(SERVER_KEY, origin);
  } catch {
    // localStorage kullanılamıyorsa adres bir sonraki açılışta yeniden sorulur.
  }
}

/** @returns {Promise<"up" | "down" | "unknown" | "unreachable">} */
async function checkServer(origin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/api/health`, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    try {
      return readHealth(await res.json());
    } catch {
      return "unknown";
    }
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

function showSetup(value, messageKey) {
  $("#connecting").hidden = true;
  $("#setup").hidden = false;
  if (value !== undefined) $("#server-input").value = value;
  setStatus(messageKey ? text(messageKey) : "", Boolean(messageKey));
  $("#server-input").focus();
}

function setStatus(message, isError) {
  const status = $("#status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function openPanel(origin) {
  save(origin);
  window.location.replace(`${origin}/`);
}

async function connectSaved(origin) {
  let cancelled = false;
  $("#setup").hidden = true;
  $("#connecting").hidden = false;
  $("#connecting-host").textContent = new URL(origin).host;
  $("#change").addEventListener(
    "click",
    () => {
      cancelled = true;
      showSetup(origin);
    },
    { once: true },
  );
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const [health] = await Promise.all([
    checkServer(origin),
    new Promise((resolve) => setTimeout(resolve, isMobile ? MOBILE_GRACE_MS : 0)),
  ]);
  if (cancelled) return;
  if (health === "up") openPanel(origin);
  else showSetup(origin, health);
}

async function submit(event) {
  event.preventDefault();
  const parsed = normalizeServerUrl($("#server-input").value);
  if (!parsed.ok) {
    setStatus(text(parsed.reason), true);
    return;
  }
  const button = $("#submit");
  button.disabled = true;
  setStatus(text("checking"), false);
  const health = await checkServer(parsed.origin);
  button.disabled = false;
  if (health === "up") openPanel(parsed.origin);
  else setStatus(text(health), true);
}

document.addEventListener("DOMContentLoaded", () => {
  document.documentElement.lang = lang;
  document.title = text("setupTitle");
  for (const node of document.querySelectorAll("[data-text]")) node.textContent = text(node.dataset.text);
  $("#server-form").addEventListener("submit", (event) => void submit(event));

  // `?change=1`: masaüstü menüsündeki "Sunucu adresini değiştir" bu ekrana böyle döner.
  const forceSetup = new URLSearchParams(window.location.search).has("change");
  const saved = normalizeServerUrl(readSaved());
  if (saved.ok && !forceSetup) void connectSaved(saved.origin);
  else showSetup(saved.ok ? saved.origin : undefined);
});
