/* Fleet Fuel Manager - screens. app.js draws the screens and sends what the user types to store.js,
   which holds the data and does all rules and calculations. */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v)) ? "-" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const when = s => { if (!s) return "-"; const [d, t] = s.split(" "); const dt = new Date(d + "T00:00"); return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) + (t ? ", " + t : ""); };
const dayOnly = s => when(s).split(",")[0] + (s && s.includes(" ") ? "" : "");

const state = { meta: null, vehicles: [], editFill: null, editVeh: null, odoVehicle: null, fuelRows: new Map() };

// ---------------------------------------------------------------- data calls
// There is no server in this version: store.js keeps the data in the browser and answers like a server would.
async function api(url, opts = {}) { return Store.handle(opts.method || "GET", url, opts.json); }
const qs = params => { const u = new URLSearchParams(); for (const [k, v] of params) if (v !== "" && v !== null && v !== undefined) u.append(k, v); const s = u.toString(); return s ? "?" + s : ""; };
function formParams(form) {
  const fd = new FormData(form), out = [];
  for (const [k, v] of fd.entries()) out.push([k, v]);
  return out;
}

let toastTimer;
function toast(msg, isErr) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3600);
}

// ---------------------------------------------------------------- navigation
const loaders = {};
function show(view) {
  if (!$("#view-" + view)) view = "dashboard";
  $$(".view").forEach(v => v.hidden = v.id !== "view-" + view);
  $$(".tab").forEach(t => t.classList.toggle("is-active", t.dataset.view === view));
  if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
  loaders[view] && loaders[view]();
}
$$(".tab").forEach(t => t.addEventListener("click", () => show(t.dataset.view)));
$$("dialog [data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));
$$("dialog").forEach(d => d.addEventListener("click", e => { if (e.target === d) d.close(); }));

async function loadVehicles() { state.vehicles = await api("/api/vehicles"); return state.vehicles; }
function fillVehicleSelect(sel, { all = false, activeOnly = false, keep = true } = {}) {
  const old = sel.value;
  const list = activeOnly ? state.vehicles.filter(v => v.active) : state.vehicles;
  sel.innerHTML = (all ? '<option value="">All vehicles</option>' : "") +
    list.map(v => `<option value="${esc(v.vehicle_id)}">${esc(v.vehicle_id)} - ${esc(v.registration)}${v.active ? "" : " (inactive)"}</option>`).join("");
  if (keep && [...sel.options].some(o => o.value === old)) sel.value = old;
}

// ---------------------------------------------------------------- charts (drawn as SVG)
function niceMax(v) { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
const short = v => v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + "k" : String(Math.round(v * 10) / 10);
const CH = { W: 560, H: 270, l: 46, r: 12, t: 22, b: 34 };

function frame(max, ticks = 4) {
  const { W, H, l, r, t, b } = CH; const ph = H - t - b; let g = "";
  for (let i = 0; i <= ticks; i++) {
    const y = t + ph - (ph * i) / ticks;
    g += `<line class="grid" x1="${l}" x2="${W - r}" y1="${y}" y2="${y}"/><text class="axis" x="${l - 6}" y="${y + 4}" text-anchor="end">${short(max * i / ticks)}</text>`;
  }
  return g;
}
const emptyChart = msg => `<svg viewBox="0 0 ${CH.W} 160" role="img"><text class="empty" x="${CH.W / 2}" y="80">${esc(msg)}</text></svg>`;

function barChart(el, items, { fmtVal = v => num(v, 1), unit = "" } = {}) {
  const known = items.filter(i => i.value !== null && i.value !== undefined);
  if (!items.length || !known.length) { el.innerHTML = emptyChart("No valid intervals in this selection"); return; }
  const { W, H, l, r, t, b } = CH, max = niceMax(Math.max(...known.map(i => i.value)) * 1.08), ph = H - t - b, bw = (W - l - r) / items.length;
  let s = frame(max);
  items.forEach((it, i) => {
    const x = l + i * bw, w = Math.min(bw * .6, 56), cx = x + bw / 2;
    if (it.value === null || it.value === undefined) { s += `<text class="axis" x="${cx}" y="${t + ph - 6}" text-anchor="middle">n/a</text>`; }
    else {
      const h = ph * it.value / max;
      s += `<rect class="bar-rect" x="${cx - w / 2}" y="${t + ph - h}" width="${w}" height="${h}" rx="5" style="fill:${it.color || "var(--bar)"}"><title>${esc(it.label)}: ${fmtVal(it.value)} ${unit}</title></rect>`;
      s += `<text class="val" x="${cx}" y="${t + ph - h - 6}">${fmtVal(it.value)}</text>`;
    }
    s += `<text class="xl" x="${cx}" y="${H - 12}">${esc(it.label)}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${s}</svg>`;
}

function stackedChart(el, items) {
  if (!items.length || !items.some(i => i.a + i.b > 0)) { el.innerHTML = emptyChart("No costs in this selection"); return; }
  const { W, H, l, r, t, b } = CH, max = niceMax(Math.max(...items.map(i => i.a + i.b)) * 1.08), ph = H - t - b, bw = (W - l - r) / items.length;
  let s = frame(max);
  items.forEach((it, i) => {
    const cx = l + i * bw + bw / 2, w = Math.min(bw * .6, 56), ha = ph * it.a / max, hb = ph * it.b / max;
    s += `<rect class="bar-rect" x="${cx - w / 2}" y="${t + ph - ha}" width="${w}" height="${ha}" style="fill:var(--fuel)"><title>${esc(it.label)} fuel: ${num(it.a)}</title></rect>`;
    if (hb > 0) s += `<rect class="bar-rect" x="${cx - w / 2}" y="${t + ph - ha - hb}" width="${w}" height="${hb}" rx="4" style="fill:var(--maint)"><title>${esc(it.label)} maintenance: ${num(it.b)}</title></rect>`;
    s += `<text class="val" x="${cx}" y="${t + ph - ha - hb - 6}">${short(it.a + it.b)}</text><text class="xl" x="${cx}" y="${H - 12}">${esc(it.label)}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${s}</svg>`;
}

function lineChart(el, labels, series) {
  if (!labels.length) { el.innerHTML = emptyChart("No records in this selection"); return; }
  const { W, H, l, r, t, b } = CH, all = series.flatMap(s => s.values), max = niceMax(Math.max(...all, 1) * 1.08), ph = H - t - b;
  const step = labels.length > 1 ? (W - l - r - 20) / (labels.length - 1) : 0, x = i => l + 10 + i * step, y = v => t + ph - ph * v / max;
  let s = frame(max);
  labels.forEach((lb, i) => { s += `<text class="xl" x="${labels.length > 1 ? x(i) : (W + l) / 2}" y="${H - 12}">${esc(lb)}</text>`; });
  series.forEach(se => {
    const pts = se.values.map((v, i) => [labels.length > 1 ? x(i) : (W + l) / 2, y(v)]);
    s += `<polyline fill="none" stroke="${se.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" ${se.dash ? 'stroke-dasharray="7 5"' : ""} points="${pts.map(p => p.join(",")).join(" ")}"/>`;
    pts.forEach((p, i) => { s += `<circle cx="${p[0]}" cy="${p[1]}" r="4.5" fill="#fff" stroke="${se.color}" stroke-width="2.5"><title>${esc(labels[i])} - ${esc(se.name)}: ${num(se.values[i])}</title></circle>`; });
    if (se.labelPoints) pts.forEach((p, i) => { s += `<text class="val" x="${p[0]}" y="${p[1] - 10}">${short(se.values[i])}</text>`; });
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${s}</svg>`;
}

// ---------------------------------------------------------------- DASHBOARD
const dashForm = $("#dashFilters");
function dashQuery() {
  const p = [["start", dashForm.start.value], ["end", dashForm.end.value]];
  $$("#dashVehicles input:checked").forEach(c => p.push(["vehicle", c.value]));
  return qs(p);
}
function buildChips() {
  const checked = new Set($$("#dashVehicles input:checked").map(c => c.value));
  $("#dashVehicles").innerHTML = state.vehicles.map(v =>
    `<label class="chip"><input type="checkbox" value="${esc(v.vehicle_id)}" ${checked.has(v.vehicle_id) ? "checked" : ""}><span>${esc(v.vehicle_id)}${v.active ? "" : " (inactive)"}</span></label>`).join("");
}
$("#dashClear").onclick = () => { dashForm.reset(); $$("#dashVehicles input").forEach(c => c.checked = false); loaders.dashboard(); };
dashForm.addEventListener("change", () => loaders.dashboard());

loaders.dashboard = async function () {
  if (!state.vehicles.length) await loadVehicles();
  if (!$("#dashVehicles").children.length) buildChips();
  const counts = await api("/api/counts"); $("#emptyBanner").hidden = counts.vehicles > 0 && counts.fuel_log > 0;
  const d = await api("/api/dashboard" + dashQuery());
  const k = d.kpis, vlabel = id => { const v = state.vehicles.find(x => x.vehicle_id === id); return v ? `${id} - ${v.make_model || v.registration}` : id; };
  $("#dashPeriod").textContent = d.span.first ? `Data available: ${when(d.span.first)} to ${when(d.span.last)}. Fuel economy and cost per km use valid intervals only (the first refuelling of each vehicle is a starting point).` : "No refuelling records yet.";
  $("#kpis").innerHTML = [
    ["Total km served", num(k.total_km), "valid intervals"], ["Fuel consumed", num(k.litres, 1) + " L", `avg ${num(k.km_per_litre, 2)} km/L`],
    ["Fuel expenditure", num(k.fuel_cost), "calculated: litres × price"], ["Overall cost per km", num(k.cost_per_km, 2), "fuel cost ÷ km"],
    ["Maintenance & other", num(k.maintenance), "separate category"], ["Records to check", `${k.flagged} / ${k.alerts}`, "data problems / alerts"]
  ].map(([a, b, c]) => `<div class="kpi"><small>${a}</small><b>${b}</b><i>${c}</i></div>`).join("");
  $("#spotlight").innerHTML = [
    ["best", "🏆", "Most economical", k.best, v => `${num(v, 2)} km per litre`], ["worst", "⚠️", "Least economical", k.worst, v => `${num(v, 2)} km per litre`],
    ["top", "⛽", "Highest fuel consumer", k.top, v => `${num(v, 1)} litres in total`]
  ].map(([cls, ico, title, o, f]) => `<div class="spot ${cls}"><div class="ico">${ico}</div><div><small>${title}</small><b>${o ? esc(vlabel(o.value === undefined ? "" : o.vehicle_id)) : "Not enough data"}</b><span>${o ? f(o.value) : "Needs at least two refuellings"}</span></div></div>`).join("");

  barChart($("#chEco"), d.summary.map(s => ({ label: s.vehicle_id, value: s.km_per_litre, color: k.best && s.vehicle_id === k.best.vehicle_id ? "var(--best)" : (k.worst && s.vehicle_id === k.worst.vehicle_id && k.worst.vehicle_id !== k.best.vehicle_id) ? "var(--worst)" : "var(--bar)" })), { fmtVal: v => num(v, 1), unit: "km/L" });
  const cp = d.summary.map(s => s.cost_per_km).filter(v => v !== null), lo = Math.min(...cp), hi = Math.max(...cp);
  barChart($("#chCpk"), d.summary.map(s => ({ label: s.vehicle_id, value: s.cost_per_km, color: s.cost_per_km !== null && s.cost_per_km === lo && lo !== hi ? "var(--best)" : s.cost_per_km !== null && s.cost_per_km === hi && lo !== hi ? "var(--worst)" : "var(--bar)" })), { fmtVal: v => num(v, 1), unit: "per km" });
  stackedChart($("#chRun"), d.summary.map(s => ({ label: s.vehicle_id, a: s.fuel_cost, b: s.maintenance })));
  lineChart($("#chTrend"), d.trend.map(t => t.label), [
    { name: "Fuel cost", values: d.trend.map(t => t.fuel_cost), color: "var(--fuel)", labelPoints: true },
    { name: "Maintenance", values: d.trend.map(t => t.maintenance), color: "var(--maint)", dash: true }]);
  $("#lgTrend").innerHTML = '<span><i style="background:var(--fuel)"></i>Fuel cost</span><span><i style="background:var(--maint)"></i>Maintenance and other</span>';
  $("#lgRun").innerHTML = '<span><i style="background:var(--fuel)"></i>Fuel</span><span><i style="background:var(--maint)"></i>Maintenance and other</span>';

  $("#summaryTable").innerHTML = `<thead><tr><th class="l">Vehicle</th><th class="l">Driver</th><th>Refuellings</th><th>Km (valid)</th><th>Litres</th><th>Fuel cost</th><th>Km/L</th><th>Cost/km</th><th>Maintenance</th><th>Total running cost</th></tr></thead><tbody>` +
    d.summary.map(s => `<tr class="${s.active ? "" : "inactive"}"><td class="l"><b>${esc(s.vehicle_id)}</b> <span class="muted">${esc(s.make_model)}</span></td><td class="l">${esc(s.driver) || "-"}</td><td>${s.fills}</td><td>${num(s.valid_km)}</td><td>${num(s.litres, 1)}</td><td>${num(s.fuel_cost)}</td><td>${num(s.km_per_litre, 2)}</td><td>${num(s.cost_per_km, 2)}</td><td>${num(s.maintenance)}</td><td><b>${num(s.running_cost)}</b></td></tr>`).join("") + "</tbody>";
  $("#attention").innerHTML = d.attention.length ? fuelTable(d.attention, false) : '<div class="empty-note">Nothing to check in this selection.</div>';
};

$("#loadDemo").onclick = () => { Store.reset(false); state.vehicles = []; $("#dashVehicles").innerHTML = ""; state.odoVehicle = null; loaders.dashboard(); };

// ---------------------------------------------------------------- ODOMETER
const DIGITS = 6, odoEl = $("#odometer"), strips = [];
for (let i = 0; i < DIGITS; i++) {
  const d = document.createElement("div"); d.className = "digit" + (i === DIGITS - 1 ? " last" : "");
  const s = document.createElement("div"); s.className = "strip";
  for (let n = 0; n <= 9; n++) { const sp = document.createElement("span"); sp.textContent = n; s.appendChild(sp); }
  d.appendChild(s); odoEl.appendChild(d); strips.push(s);
}
function showKm(km) {
  const t = String(Math.max(0, Math.min(10 ** DIGITS - 1, Math.floor(km || 0)))).padStart(DIGITS, "0");
  strips.forEach((s, i) => s.style.transform = `translateY(${-Number(t[i]) * 10}%)`);   // strip = digits 0-9; 10% of its height = one digit
}
const GAUGE_MAX = 20, ANGLE = 125;
(function drawTicks() {
  let s = "";
  for (let v = 0; v <= GAUGE_MAX; v += 5) {
    const a = (-ANGLE + (v / GAUGE_MAX) * 2 * ANGLE) * Math.PI / 180, x = 150 + 138 * Math.sin(a), y = 150 - 138 * Math.cos(a);
    s += `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}">${v}</text>`;
  }
  $("#gaugeTicks").innerHTML = s;
})();
function showGauge(kmpl) {
  const v = kmpl === null || kmpl === undefined ? 0 : Math.min(kmpl, GAUGE_MAX);
  $("#gaugeNeedle").style.transform = `rotate(${-ANGLE + (v / GAUGE_MAX) * 2 * ANGLE}deg)`;
  $("#gaugeFill").setAttribute("stroke-dasharray", `${(v / GAUGE_MAX) * 100} 100`);
  $("#gaugeVal").textContent = kmpl === null || kmpl === undefined ? "n/a" : num(kmpl, 1);
}
$("#odoVehicle").onchange = e => { state.odoVehicle = e.target.value; loaders.odometer(true); };

loaders.odometer = async function (rolling) {
  await loadVehicles();
  const sel = $("#odoVehicle");
  if (!state.odoVehicle || !state.vehicles.some(v => v.vehicle_id === state.odoVehicle)) state.odoVehicle = (state.vehicles.find(v => v.last_odometer !== null) || state.vehicles[0] || {}).vehicle_id;
  fillVehicleSelect(sel, { keep: false }); sel.value = state.odoVehicle || "";
  const v = state.vehicles.find(x => x.vehicle_id === state.odoVehicle);
  if (!v) { $("#odoMeta").textContent = "No vehicles yet."; showKm(0); showGauge(null); return; }
  $("#odoMeta").innerHTML = `<span>Registration <b>${esc(v.registration)}</b></span><span>Driver <b>${esc(v.driver) || "-"}</b></span><span>Model <b>${esc(v.make_model) || "-"}</b></span><span>Last reading <b>${when(v.last_fill)}</b></span>`;
  $("#odoNote").textContent = v.last_odometer === null ? "No refuelling recorded yet, so no odometer reading." : v.last_odometer > 999999 ? "Reading is above 999,999 km: the display shows the last six digits." : `Latest reading from the fuel log (${v.fills} refuelling${v.fills === 1 ? "" : "s"}).`;
  if (!rolling) showKm(0);
  requestAnimationFrame(() => requestAnimationFrame(() => showKm((v.last_odometer || 0) % 10 ** DIGITS)));
  $("#odoAll").innerHTML = state.vehicles.map(x => `<button class="mini ${x.vehicle_id === v.vehicle_id ? "is-on" : ""}" data-v="${esc(x.vehicle_id)}"><div><b>${esc(x.vehicle_id)} · ${esc(x.registration)}</b><span>${esc(x.driver) || "-"} · ${x.last_fill ? when(x.last_fill) : "no refuelling yet"}</span></div><div class="km">${x.last_odometer === null ? "------" : String(x.last_odometer % 10 ** DIGITS).padStart(DIGITS, "0")}</div></button>`).join("");
  $$("#odoAll .mini").forEach(b => b.onclick = () => { state.odoVehicle = b.dataset.v; window.scrollTo({ top: 0, behavior: "smooth" }); loaders.odometer(true); });
  const dash = await api("/api/dashboard" + qs([["vehicle", v.vehicle_id]]));
  requestAnimationFrame(() => requestAnimationFrame(() => showGauge(dash.summary[0] ? dash.summary[0].km_per_litre : null)));
  const f = await api("/api/fuel" + qs([["vehicle", v.vehicle_id], ["limit", 6]]));
  $("#odoRecent").innerHTML = f.rows.length ? `<table><thead><tr><th class="l">Date and time</th><th>Odometer</th><th>Litres</th><th>Km driven</th><th>Km/L</th></tr></thead><tbody>${f.rows.map(r => `<tr><td class="l">${when(r.fill_datetime)}</td><td>${num(r.odometer_km)}</td><td>${num(r.litres, 1)}</td><td>${r.km_driven === null ? '<span class="badge mute">first record</span>' : num(r.km_driven)}</td><td>${num(r.km_per_litre, 2)}</td></tr>`).join("")}</tbody></table>` : '<div class="empty-note">No refuellings for this vehicle.</div>';
};

// ---------------------------------------------------------------- FUEL LOG
const fuelForm = $("#fuelFilters");
function fuelTable(rows, actions = true) {
  rows.forEach(r => state.fuelRows.set(r.fill_id, r));
  const checkBadge = r => r.data_check !== "OK" ? `<span class="badge bad" title="${esc(r.data_check)}">${esc(r.data_check)}</span>` : (r.alert ? `<span class="badge warn">${esc(r.alert)}</span>` : '<span class="badge ok">OK</span>');
  const receipt = r => r.receipt_total === null ? '<span class="badge mute">no receipt</span>' : `${num(r.receipt_total, 2)} <span class="badge ${r.receipt_check === "OK" ? "ok" : "bad"}">${r.receipt_check === "OK" ? "matches" : "mismatch"}</span>`;
  return `<table><thead><tr><th class="l">Date and time</th><th class="l">Vehicle</th><th class="l">Driver</th><th>Odometer</th><th>Litres</th><th>Price/L</th><th>Total (calc.)</th><th>Receipt</th><th>Km driven</th><th>Km/L</th><th>Cost/km</th><th class="l">Check</th>${actions ? "<th></th>" : ""}</tr></thead><tbody>` +
    rows.map(r => `<tr><td class="l">${when(r.fill_datetime)}</td><td class="l"><b>${esc(r.vehicle_id)}</b> <span class="muted">${esc(r.registration)}</span></td><td class="l">${esc(r.driver) || "-"}</td><td>${num(r.odometer_km)}</td><td>${num(r.litres, 2)}</td><td>${num(r.price_per_litre, 2)}</td><td><b>${num(r.total_cost, 2)}</b></td><td>${receipt(r)}</td>` +
      (r.prev_odometer === null ? `<td colspan="3"><span class="badge info">first record: starting point, no km/L</span></td>` : `<td>${num(r.km_driven)}</td><td>${num(r.km_per_litre, 2)}</td><td>${num(r.cost_per_km, 2)}</td>`) +
      `<td class="l">${checkBadge(r)}</td>${actions ? `<td><div class="acts"><button class="btn ghost small" data-edit="${r.fill_id}">Edit</button><button class="btn danger small" data-del="${r.fill_id}">Delete</button></div></td>` : ""}</tr>`).join("") + "</tbody></table>";
}
function fuelQuery() { return qs(formParams(fuelForm).concat([["limit", 500]])); }
fuelForm.addEventListener("change", () => loaders.fuel());
$("#fuelClear").onclick = () => { fuelForm.reset(); loaders.fuel(); };
$("#fuelAdd").onclick = () => openFuelDialog(null);

loaders.fuel = async function () {
  await loadVehicles(); fillVehicleSelect(fuelForm.vehicle, { all: true });
  const d = await api("/api/fuel" + fuelQuery());
  $("#fuelCount").textContent = d.total ? `${d.total} record${d.total === 1 ? "" : "s"}${d.total > d.rows.length ? ` (newest ${d.rows.length} shown)` : ""}. Total cost = litres × price per litre; the receipt is only compared against it.` : "";
  $("#fuelTable").innerHTML = d.rows.length ? fuelTable(d.rows) : '<div class="empty-note">No refuelling records match these filters.</div>';
};
$("#fuelTable").addEventListener("click", async e => {
  const ed = e.target.closest("[data-edit]"), del = e.target.closest("[data-del]");
  if (ed) openFuelDialog(state.fuelRows.get(Number(ed.dataset.edit)));
  if (del && confirm("Delete this refuelling record? This cannot be undone.")) {
    const r = await api("/api/fuel/" + del.dataset.del, { method: "DELETE" }); toast(r.message, !r.ok); loaders.fuel();
  }
});

const fd = $("#fuelDialog"), ff = $("#fuelForm");
function updateCalc() {
  const l = parseFloat(ff.litres.value), p = parseFloat(ff.price.value), r = ff.receipt.value === "" ? null : parseFloat(ff.receipt.value);
  let h = "Total cost = litres × price per litre: <b>-</b>";
  if (l > 0 && p > 0) {
    const t = l * p; h = `Total cost = litres × price per litre: <b>${num(t, 2)}</b>`;
    if (r !== null && !Number.isNaN(r)) { const tol = Math.max(1, .005 * t), diff = r - t; h += Math.abs(diff) <= tol ? ' <span class="badge ok">receipt matches</span>' : ` <span class="badge bad">receipt differs by ${num(diff, 2)}</span>`; }
  }
  $("#fuelCalc").innerHTML = h;
  const v = state.vehicles.find(x => x.vehicle_id === ff.vehicle_id.value);
  $("#fuelLast").textContent = v && v.last_odometer !== null ? `Last recorded odometer for ${v.vehicle_id}: ${num(v.last_odometer)} km (${when(v.last_fill)}).` : "No previous reading: this will be the starting point (no km/L).";
}
["litres", "price", "receipt", "vehicle_id"].forEach(n => ff[n].addEventListener("input", updateCalc));
async function openFuelDialog(row) {
  await loadVehicles(); state.editFill = row;
  fillVehicleSelect(ff.vehicle_id, { activeOnly: !row, keep: false });
  ff.reset(); $("#fuelMsg").textContent = ""; $("#fuelMsg").className = "msgbox"; $("#fuelConfirmRow").hidden = true;
  $("#fuelTitle").textContent = row ? "Edit refuelling" : "Record refuelling";
  ff.vehicle_id.disabled = !!row;
  if (row) {
    const [d, t] = row.fill_datetime.split(" ");
    ff.vehicle_id.value = row.vehicle_id; ff.date.value = d; ff.time.value = t; ff.odometer.value = row.odometer_km; ff.litres.value = row.litres;
    ff.price.value = row.price_per_litre; ff.receipt.value = row.receipt_total ?? ""; ff.station.value = row.station;
  } else {
    const now = new Date(), p = n => String(n).padStart(2, "0");
    ff.date.value = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`; ff.time.value = `${p(now.getHours())}:${p(now.getMinutes())}`;
    if (fuelForm.vehicle.value) ff.vehicle_id.value = fuelForm.vehicle.value;
  }
  updateCalc(); fd.showModal();
}
ff.addEventListener("submit", async e => {
  e.preventDefault();
  const row = state.editFill, payload = {
    vehicle_id: ff.vehicle_id.value, date: ff.date.value, time: ff.time.value, odometer: ff.odometer.value, litres: ff.litres.value,
    price: ff.price.value, receipt: ff.receipt.value, station: ff.station.value, confirm: ff.confirm.checked };
  const r = row ? await api("/api/fuel/" + row.fill_id, { method: "PUT", json: payload }) : await api("/api/fuel", { method: "POST", json: payload });
  const box = $("#fuelMsg");
  if (r.ok) { fd.close(); toast(r.message); loaders.fuel(); return; }
  box.textContent = r.message; box.className = "msgbox" + (r.needs_confirm ? " warn" : "");
  $("#fuelConfirmRow").hidden = !r.needs_confirm;
});

// ---------------------------------------------------------------- VEHICLES
const vd = $("#vehDialog"), vf = $("#vehForm");
loaders.vehicles = async function () {
  await loadVehicles();
  $("#vehTable").innerHTML = state.vehicles.length ? `<table><thead><tr><th class="l">ID</th><th class="l">Registration</th><th class="l">Make / model</th><th class="l">Type</th><th class="l">Fuel</th><th class="l">Driver</th><th>Refuellings</th><th>Odometer</th><th class="l">Status</th><th></th></tr></thead><tbody>` +
    state.vehicles.map(v => `<tr class="${v.active ? "" : "inactive"}"><td class="l"><b>${esc(v.vehicle_id)}</b></td><td class="l">${esc(v.registration)}</td><td class="l">${esc(v.make_model) || "-"}</td><td class="l">${esc(v.vehicle_type) || "-"}</td><td class="l">${esc(v.fuel_type) || "-"}</td><td class="l">${esc(v.driver) || "-"}</td><td>${v.fills}</td><td>${v.last_odometer === null ? "-" : num(v.last_odometer)}</td><td class="l"><span class="badge ${v.active ? "ok" : "mute"}">${v.active ? "Active" : "Inactive"}</span></td><td><div class="acts"><button class="btn ghost small" data-vedit="${esc(v.vehicle_id)}">Edit</button><button class="btn ghost small" data-vtoggle="${esc(v.vehicle_id)}">${v.active ? "Deactivate" : "Activate"}</button></div></td></tr>`).join("") + "</tbody></table>" : '<div class="empty-note">No vehicles yet. Add the first one.</div>';
};
function openVehDialog(v) {
  state.editVeh = v; vf.reset(); $("#vehMsg").textContent = "";
  const fs = vf.fuel_type; fs.innerHTML = '<option value="">-</option>' + state.meta.fuel_types.map(t => `<option>${t}</option>`).join("");
  $("#vehTitle").textContent = v ? `Edit vehicle ${v.vehicle_id}` : "Add vehicle";
  vf.vehicle_id.disabled = !!v; $("#vehActiveRow").hidden = !v;
  if (v) { for (const k of ["vehicle_id", "registration", "make_model", "vehicle_type", "fuel_type", "driver", "notes"]) vf[k].value = v[k] ?? ""; vf.active.checked = !!v.active; }
  vd.showModal();
}
$("#vehAdd").onclick = () => openVehDialog(null);
$("#vehTable").addEventListener("click", async e => {
  const ed = e.target.closest("[data-vedit]"), tg = e.target.closest("[data-vtoggle]");
  if (ed) openVehDialog(state.vehicles.find(v => v.vehicle_id === ed.dataset.vedit));
  if (tg) { const v = state.vehicles.find(x => x.vehicle_id === tg.dataset.vtoggle); const r = await api(`/api/vehicles/${encodeURIComponent(v.vehicle_id)}/active`, { method: "POST", json: { active: !v.active } }); toast(r.message, !r.ok); dashRefreshChips(); loaders.vehicles(); }
});
vf.addEventListener("submit", async e => {
  e.preventDefault(); const v = state.editVeh;
  const p = Object.fromEntries(["vehicle_id", "registration", "make_model", "vehicle_type", "fuel_type", "driver", "notes"].map(k => [k, vf[k].value])); p.active = vf.active.checked;
  const r = v ? await api("/api/vehicles/" + encodeURIComponent(v.vehicle_id), { method: "PUT", json: p }) : await api("/api/vehicles", { method: "POST", json: p });
  if (r.ok) { vd.close(); toast(r.message); dashRefreshChips(); loaders.vehicles(); } else { $("#vehMsg").textContent = r.message; $("#vehMsg").className = "msgbox"; }
});
async function dashRefreshChips() { await loadVehicles(); buildChips(); }

// ---------------------------------------------------------------- MAINTENANCE
const mainForm = $("#mainFilters"), md = $("#mainDialog"), mf = $("#mainForm");
mainForm.addEventListener("change", () => loaders.maintenance());
$("#mainClear").onclick = () => { mainForm.reset(); loaders.maintenance(); };
$("#mainAdd").onclick = async () => {
  await loadVehicles(); fillVehicleSelect(mf.vehicle_id, { keep: false }); mf.reset(); $("#mainMsg").textContent = "";
  mf.category.innerHTML = state.meta.categories.map(c => `<option>${c}</option>`).join(""); mf.date.value = state.meta.today;
  if (mainForm.vehicle.value) mf.vehicle_id.value = mainForm.vehicle.value; md.showModal();
};
loaders.maintenance = async function () {
  await loadVehicles(); fillVehicleSelect(mainForm.vehicle, { all: true });
  if (mainForm.category.options.length === 0) mainForm.category.innerHTML = '<option value="">All categories</option>' + state.meta.categories.map(c => `<option>${c}</option>`).join("");
  const d = await api("/api/maintenance" + qs(formParams(mainForm)));
  $("#mainKpis").innerHTML = `<div class="kpi"><small>Total in selection</small><b>${num(d.total)}</b><i>${d.rows.length} expense${d.rows.length === 1 ? "" : "s"}</i></div>` +
    Object.entries(d.by_category).map(([c, v]) => `<div class="kpi"><small>${esc(c)}</small><b>${num(v)}</b></div>`).join("");
  $("#mainTable").innerHTML = d.rows.length ? `<table><thead><tr><th class="l">Date</th><th class="l">Vehicle</th><th class="l">Category</th><th class="l">Description</th><th>Cost</th><th>Odometer</th><th class="l">Notes</th><th></th></tr></thead><tbody>` +
    d.rows.map(r => `<tr><td class="l">${when(r.maint_date)}</td><td class="l"><b>${esc(r.vehicle_id)}</b> <span class="muted">${esc(r.registration)}</span></td><td class="l"><span class="badge info">${esc(r.category)}</span></td><td class="l">${esc(r.description)}</td><td><b>${num(r.cost, 2)}</b></td><td>${r.odometer_km === null ? "-" : num(r.odometer_km)}</td><td class="l">${esc(r.notes)}</td><td><button class="btn danger small" data-mdel="${r.maint_id}">Delete</button></td></tr>`).join("") + "</tbody></table>" : '<div class="empty-note">No expenses match these filters.</div>';
};
$("#mainTable").addEventListener("click", async e => {
  const b = e.target.closest("[data-mdel]");
  if (b && confirm("Delete this expense?")) { const r = await api("/api/maintenance/" + b.dataset.mdel, { method: "DELETE" }); toast(r.message, !r.ok); loaders.maintenance(); }
});
mf.addEventListener("submit", async e => {
  e.preventDefault();
  const p = { vehicle_id: mf.vehicle_id.value, date: mf.date.value, category: mf.category.value, description: mf.description.value, cost: mf.cost.value, odometer: mf.odometer.value, notes: mf.notes.value };
  const r = await api("/api/maintenance", { method: "POST", json: p });
  if (r.ok) { md.close(); toast(r.message); loaders.maintenance(); } else { $("#mainMsg").textContent = r.message; $("#mainMsg").className = "msgbox"; }
});

// ---------------------------------------------------------------- DATA
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + text], { type: type + ";charset=utf-8" }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
loaders.data = async function () {
  const c = await api("/api/counts");
  $("#dataCounts").textContent = `Stored in this browser now: ${c.vehicles} vehicles, ${c.fuel_log} refuellings, ${c.maintenance} maintenance records.`;
};
$("#exFuel").onclick = () => download("fuel_log.csv", Store.fuelCsv(), "text/csv");
$("#exMaint").onclick = () => download("maintenance.csv", Store.maintCsv(), "text/csv");
$("#exSummary").onclick = () => download("vehicle_summary.csv", Store.summaryCsv(), "text/csv");

// ---------------------------------------------------------------- start
(async function start() {
  state.meta = await api("/api/meta"); await loadVehicles();
  show(location.hash.slice(1) || "dashboard");
})();
