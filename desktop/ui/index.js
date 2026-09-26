// ADR-0003: masaüstü kabuğu yalnızca @admedic/api salt okunur REST'ini tüketir.
// API'den gelen hiçbir dizgi innerHTML ile yazılmaz (XSS); tüm çıktı textContent / DOM API ile üretilir.
const API_BASE = (globalThis.__API_BASE__ || "http://127.0.0.1:3001").replace(/\/$/, "");
const TOKEN_KEY = "api-token";
const DAYS = 7;
const $ = (sel) => document.querySelector(sel);

function readToken() {
  if (globalThis.__API_TOKEN__) return String(globalThis.__API_TOKEN__);
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}
function saveToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage kullanılamıyorsa belirteç yalnızca bu oturumda tutulur.
  }
}

function money(cents, currency) {
  const code = /^[A-Za-z]{3}$/.test(currency || "") ? currency.toUpperCase() : "EUR";
  const value = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency: code, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(value)} ${code}`;
  }
}
function fmtRoas(roas) {
  return roas === null || roas === undefined ? "—" : `${Number(roas).toFixed(2)}×`;
}
function fmtNumber(value) {
  return value === null || value === undefined ? "—" : new Intl.NumberFormat("tr-TR").format(Number(value));
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderCards(container, rows) {
  clear(container);
  for (const [label, value] of rows) {
    const card = el("div", null, "card");
    card.appendChild(el("div", label, "label"));
    card.appendChild(el("div", value ?? "—", "value"));
    container.appendChild(card);
  }
}

function renderTable(table, campaigns, currency) {
  clear(table);
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const title of ["Kampanya", "Durum", "Günlük bütçe", `${DAYS}g Harcama`, "ROAS"]) headRow.appendChild(el("th", title));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const c of campaigns) {
    const row = document.createElement("tr");
    const rowCurrency = c.adAccount?.currency || currency;
    row.appendChild(el("td", c.name ?? "—"));
    row.appendChild(el("td", c.status ?? "—"));
    row.appendChild(el("td", money(c.dailyBudgetCents, rowCurrency)));
    row.appendChild(el("td", money(c.lastNDays?.spendCents, rowCurrency)));
    row.appendChild(el("td", fmtRoas(c.lastNDays?.roas)));
    tbody.appendChild(row);
  }
  if (campaigns.length === 0) {
    const row = document.createElement("tr");
    const cell = el("td", "Kampanya yok.", "muted");
    cell.colSpan = 5;
    row.appendChild(cell);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
}

function renderAlerts(container, alerts, summary) {
  clear(container);
  container.appendChild(el("h2", `Uyarılar (${fmtNumber(summary?.open ?? alerts.length)} açık)`));
  const list = document.createElement("ul");
  for (const a of alerts.slice(0, 10)) {
    const item = el("li", `${a.severity ?? "INFO"} · ${a.title ?? a.message ?? a.type ?? "—"}`, `sev-${a.severity ?? "INFO"}`);
    list.appendChild(item);
  }
  if (alerts.length === 0) list.appendChild(el("li", "Açık uyarı yok.", "muted"));
  container.appendChild(list);
}

async function apiGet(path) {
  const headers = { accept: "application/json" };
  const token = readToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") detail = `${res.status}: ${body.error}`;
    } catch {
      // gövde JSON değil
    }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function setTitle(appName) {
  const name = appName && String(appName).trim() ? String(appName) : "Panel";
  document.title = `${name} — Masaüstü`;
  $("h1").textContent = name;
}

async function load() {
  const status = $("#status");
  const tokenForm = $("#token-form");
  status.textContent = "bağlanıyor…";
  status.classList.remove("error");
  let data;
  try {
    data = await apiGet(`/v1/overview?days=${DAYS}`);
  } catch (e) {
    status.textContent =
      e.status === 401 || e.status === 503
        ? `API belirteci gerekli (${e.message}).`
        : `API yok (${API_BASE}: ${e.message}) — önce 'pnpm api:dev' çalıştırın.`;
    status.classList.add("error");
    tokenForm.classList.toggle("visible", e.status === 401 || e.status === 503);
    return;
  }
  tokenForm.classList.remove("visible");
  setTitle(data.appName);
  const currency = data.workspace?.currency || "EUR";
  $("#ws").textContent = data.workspace?.name ?? "";
  $("#meta").textContent = `${currency} · ${DAYS} gün · ROAS ${fmtRoas(data.lastNDays?.roas)}`;
  renderCards($("#cards"), [
    ["Kampanya", fmtNumber(data.counts?.campaigns)],
    ["Ad Set", fmtNumber(data.counts?.adsets)],
    ["Reklam", fmtNumber(data.counts?.ads)],
    [`${DAYS}g Harcama`, money(data.lastNDays?.spendCents, currency)],
    [`${DAYS}g Gelir`, money(data.lastNDays?.revenueCents, currency)],
    ["Bekleyen onay", fmtNumber(data.approvals?.pending)],
  ]);
  renderTable($("#table"), Array.isArray(data.campaigns) ? data.campaigns : [], currency);
  try {
    const alerts = await apiGet("/v1/alerts");
    renderAlerts($("#alerts"), Array.isArray(alerts.alerts) ? alerts.alerts : [], alerts.summary);
  } catch {
    renderAlerts($("#alerts"), [], { open: data.alerts?.open ?? 0 });
  }
  status.textContent = `canlı — ${API_BASE}`;
}

document.addEventListener("DOMContentLoaded", () => {
  setTitle(null);
  $("#token-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveToken($("#token-input").value.trim());
    $("#token-input").value = "";
    void load();
  });
  void load();
});
