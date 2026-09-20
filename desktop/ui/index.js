const API_BASE = (globalThis.__API_BASE__ || "http://127.0.0.1:3001").replace(/\/$/, "");
const $ = (sel) => document.querySelector(sel);
const SEP = { CRITICAL: "#c0392b", WARNING: "#b7950b", INFO: "#2471a3" };

function money(cents, currency = "EUR") {
  return `${new Intl.NumberFormat("tr-TR", { style: "currency", currency }).format((cents ?? 0) / 100)}`;
}
function fmtRoas(roas) {
  return roas === null ? "—" : Number(roas).toFixed(2) + "×";
}

document.addEventListener("DOMContentLoaded", async () => {
  const status = $("#status");
  const ws = $("#ws");
  const meta = $("#meta");

  let data;
  try {
    const res = await fetch(`${API_BASE}/v1/overview?days=7`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    data = await res.json();
  } catch (e) {
    status.textContent = `API yok (${API_BASE}/${e.message}) — önce 'pnpm --filter @admedic/api dev'`;
    status.classList.add("muted");
    return;
  }

  ws.textContent = data.workspace?.name ?? "";
  meta.textContent = `${data.workspace?.currency ?? "EUR"} · 7 gün · ROAS ${fmtRoas(data.lastNDays?.roas)}`;

  const cards = [
    ["Kampanya", data.counts?.campaigns],
    ["Ad Set", data.counts?.adsets],
    ["Reklam", data.counts?.ads],
    ["7g Harcama", money(data.lastNDays?.spendCents)],
  ];
  $("#cards").innerHTML = cards
    .map(([k, v]) => `<div class="card"><div class="label">${k}</div><div class="value">${v ?? "—"}</div></div>`)
    .join("");

  const rows = (data.campaigns ?? []).map(
    (c) =>
      `<tr><td>${c.name ?? "—"}</td><td>${c.status ?? "—"}</td><td>${fmtRoas(c.lastNDays?.roas)}</td><td>${money(c.lastNDays?.spendCents)}</td></tr>`
  );
  $("#table").innerHTML = `<thead><tr><th>Kampanya</th><th>Durum</th><th>ROAS</th><th>7g Harcama</th></tr></thead><tbody>${rows.join("")}</tbody>`;
  status.textContent = "canlı — REST 3001";
});
