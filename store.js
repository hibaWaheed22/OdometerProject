/* store.js - the "database" and all rules/calculations, running inside the browser.
   Data is saved in the browser's localStorage (key below), so it stays after the page is closed.
   app.js talks to this file through Store.handle(), which answers like a small server would. */
"use strict";
const Store = (() => {
  const KEY = "fleetFuelManager_v1";
  const CATEGORIES = ["Service", "Tyres", "Repair", "Insurance", "Other"];
  const FUEL_TYPES = ["Petrol", "Diesel", "CNG", "Hybrid", "Electric"];
  // ---- rules and thresholds (change a number here to change the rule) ----
  const MAX_PLAUSIBLE_KM = 2000;     // more km than this between two refuellings is "suspicious"
  const MAX_LITRES = 500;            // more litres than this in one refuelling is rejected
  const S = { low: 0.15, high: 0.10, tolAbs: 1, tolPct: 0.005 };   // alerts: km/L 15% below avg, price 10% above avg; receipt tolerance max(1, 0.5%)

  let db;
  const clone = o => JSON.parse(JSON.stringify(o));
  function seed() {
    const d = { vehicles: clone(SEED.vehicles), fuel: [], maint: [], nextFill: 1, nextMaint: 1 };
    SEED.fuel.forEach(f => d.fuel.push({ fill_id: d.nextFill++, ...clone(f) }));
    SEED.maint.forEach(m => d.maint.push({ maint_id: d.nextMaint++, ...clone(m) }));
    return d;
  }
  function load() {
    try { const raw = localStorage.getItem(KEY); if (raw) { const d = JSON.parse(raw); if (d && Array.isArray(d.vehicles) && Array.isArray(d.fuel) && Array.isArray(d.maint)) return d; } } catch (e) {}
    return seed();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
  db = load();

  // ---------------------------------------------------------------- results
  const ok = m => ({ ok: true, message: m, needs_confirm: false });
  const fail = m => ({ ok: false, message: m, needs_confirm: false });
  const confirmMsg = m => ({ ok: false, message: m, needs_confirm: true });
  const fmt = (v, d = 2) => Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

  // ---------------------------------------------------------------- small helpers
  const num = v => { if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const isDate = s => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false; const [y, m, d] = s.split("-").map(Number), t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
  const isTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || "");
  const stamp = (d, t) => (isDate(d) ? d + " " + (isTime(t) ? t : "00:00") : null);
  const today = () => { const n = new Date(), p = x => String(x).padStart(2, "0"); return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`; };
  const byKey = (...keys) => (a, b) => { for (const k of keys) { if (a[k] < b[k]) return -1; if (a[k] > b[k]) return 1; } return 0; };

  // ---------------------------------------------------------------- calculations
  /* Every refuelling with the calculated columns:
     km_driven = odometer - previous odometer of the same vehicle   (first record: no value)
     km_per_litre = km_driven / litres   (full-tank to full-tank method, only for valid intervals)
     cost_per_km = total_cost / km_driven   (only for valid intervals) */
  function fuelFrame() {
    const vm = new Map(db.vehicles.map(v => [v.vehicle_id, v]));
    const rows = db.fuel.filter(f => vm.has(f.vehicle_id)).map(f => {
      const v = vm.get(f.vehicle_id);
      return { ...f, registration: v.registration, driver: v.driver, make_model: v.make_model };
    }).sort(byKey("vehicle_id", "fill_datetime", "fill_id"));
    let pv = null, prevOdo = null;
    for (const r of rows) {
      r.prev_odometer = pv === r.vehicle_id ? prevOdo : null;
      pv = r.vehicle_id; prevOdo = r.odometer_km;
      r.km_driven = r.prev_odometer === null ? null : r.odometer_km - r.prev_odometer;
      r.total_cost = r.litres * r.price_per_litre;
      r.valid = r.km_driven !== null && r.km_driven > 0;
      r.km_per_litre = r.valid ? r.km_driven / r.litres : null;
      r.cost_per_km = r.valid ? r.total_cost / r.km_driven : null;
      if (r.receipt_total === null || r.receipt_total === undefined) { r.receipt_total = null; r.receipt_check = "No receipt"; }
      else r.receipt_check = Math.abs(r.receipt_total - r.total_cost) <= Math.max(S.tolAbs, S.tolPct * r.total_cost) ? "OK" : "Mismatch";
      const badOdo = r.km_driven !== null && r.km_driven <= 0 && !r.odometer_confirmed;
      const far = r.km_driven !== null && r.km_driven > MAX_PLAUSIBLE_KM && !r.odometer_confirmed;
      r.data_check = badOdo ? "Odometer not higher than previous" : far ? "Very long distance since previous refuelling" : r.receipt_check === "Mismatch" ? "Receipt mismatch" : "OK";
      r.fill_date = r.fill_datetime.slice(0, 10);
    }
    const sums = {};
    for (const r of rows) {
      const s = sums[r.vehicle_id] || (sums[r.vehicle_id] = { km: 0, vl: 0, cost: 0, l: 0 });
      s.cost += r.total_cost; s.l += r.litres;
      if (r.valid) { s.km += r.km_driven; s.vl += r.litres; }
    }
    for (const r of rows) {
      const s = sums[r.vehicle_id], avgKmpl = s.vl > 0 ? s.km / s.vl : null, avgPrice = s.cost / s.l;
      const low = r.km_per_litre !== null && avgKmpl !== null && r.km_per_litre < avgKmpl * (1 - S.low);
      const high = r.price_per_litre > avgPrice * (1 + S.high);
      r.alert = low && high ? "Low km/L, High price" : low ? "Low km/L" : high ? "High price" : "";
    }
    return rows;
  }
  function maintFrame() {
    const vm = new Map(db.vehicles.map(v => [v.vehicle_id, v]));
    return db.maint.filter(m => vm.has(m.vehicle_id)).map(m => ({ ...m, registration: vm.get(m.vehicle_id).registration, make_model: vm.get(m.vehicle_id).make_model }))
      .sort((a, b) => (a.maint_date < b.maint_date ? 1 : a.maint_date > b.maint_date ? -1 : b.maint_id - a.maint_id));
  }
  const inRange = (d, start, end) => (!start || d >= start) && (!end || d <= end);
  const filterFuel = (rows, start, end, ids) => rows.filter(r => inRange(r.fill_date, start, end) && (!ids.length || ids.includes(r.vehicle_id)));
  const filterMaint = (rows, start, end, ids, cat) => rows.filter(m => inRange(m.maint_date, start, end) && (!ids.length || ids.includes(m.vehicle_id)) && (!cat || m.category === cat));

  function vehicleSummary(fuel, maint, vehicles) {
    return vehicles.map(v => {
      const f = fuel.filter(r => r.vehicle_id === v.vehicle_id), ok_ = f.filter(r => r.valid);
      const sum = (a, k) => a.reduce((t, r) => t + r[k], 0);
      const validKm = sum(ok_, "km_driven"), vl = sum(ok_, "litres"), vc = sum(ok_, "total_cost");
      const fuelCost = sum(f, "total_cost"), maintCost = maint.filter(m => m.vehicle_id === v.vehicle_id).reduce((t, m) => t + m.cost, 0);
      return { vehicle_id: v.vehicle_id, registration: v.registration, make_model: v.make_model, vehicle_type: v.vehicle_type, driver: v.driver, active: v.active,
               fills: f.length, litres: sum(f, "litres"), fuel_cost: fuelCost, valid_km: validKm,
               km_per_litre: vl > 0 ? validKm / vl : null, cost_per_km: validKm > 0 ? vc / validKm : null, maintenance: maintCost, running_cost: fuelCost + maintCost };
    });
  }
  function kpis(fuel, maint, summary) {
    const valid = fuel.filter(r => r.valid), sum = (a, k) => a.reduce((t, r) => t + r[k], 0);
    const totalKm = sum(valid, "km_driven");
    const k = { total_km: totalKm, litres: sum(fuel, "litres"), fuel_cost: sum(fuel, "total_cost"),
                cost_per_km: totalKm > 0 ? sum(valid, "total_cost") / totalKm : null, km_per_litre: totalKm > 0 ? totalKm / sum(valid, "litres") : null,
                maintenance: maint.reduce((t, m) => t + m.cost, 0), flagged: fuel.filter(r => r.data_check !== "OK").length, alerts: fuel.filter(r => r.alert !== "").length,
                best: null, worst: null, top: null };
    const eco = summary.filter(s => s.km_per_litre !== null);
    if (eco.length) {
      const best = eco.reduce((a, b) => (b.km_per_litre > a.km_per_litre ? b : a)), worst = eco.reduce((a, b) => (b.km_per_litre < a.km_per_litre ? b : a));
      k.best = { vehicle_id: best.vehicle_id, value: best.km_per_litre }; k.worst = { vehicle_id: worst.vehicle_id, value: worst.km_per_litre };
    }
    const used = summary.filter(s => s.litres > 0);
    if (used.length) { const t = used.reduce((a, b) => (b.litres > a.litres ? b : a)); k.top = { vehicle_id: t.vehicle_id, value: t.litres }; }
    return k;
  }
  function monthlyTrend(fuel, maint, months = 12) {
    const f = {}, m = {};
    fuel.forEach(r => { const k = r.fill_date.slice(0, 7); f[k] = (f[k] || 0) + r.total_cost; });
    maint.forEach(r => { const k = r.maint_date.slice(0, 7); m[k] = (m[k] || 0) + r.cost; });
    const keys = Object.keys({ ...f, ...m }).sort();
    if (!keys.length) return [];
    const out = []; let [y, mo] = keys[0].split("-").map(Number); const [ey, em] = keys[keys.length - 1].split("-").map(Number);
    while (y < ey || (y === ey && mo <= em)) {
      const key = `${y}-${String(mo).padStart(2, "0")}`;
      out.push({ month: key, label: new Date(y, mo - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "2-digit" }), fuel_cost: f[key] || 0, maintenance: m[key] || 0 });
      if (++mo > 12) { mo = 1; y++; }
    }
    return out.slice(-months);
  }
  function latestReadings(fuel) {
    const out = {};
    [...fuel].sort(byKey("fill_datetime", "fill_id")).forEach(r => { out[r.vehicle_id] = { km: r.odometer_km, at: r.fill_datetime }; });
    return out;
  }

  // ---------------------------------------------------------------- rules for a new / changed refuelling
  function cleanFill(when, odometer, litres, price, receipt) {
    if (!when) return [null, "Choose a valid date and time."];
    if (new Date(when.replace(" ", "T")) > new Date(Date.now() + 5 * 60000)) return [null, "Date and time cannot be in the future."];
    const odo = num(odometer), lit = num(litres), pr = num(price), rec = num(receipt);
    if (odo === null || odo < 0 || !Number.isInteger(odo) || odo > 9999999) return [null, "Odometer must be a whole number of km (0 or more)."];
    if (lit === null || lit <= 0) return [null, "Litres must be greater than 0."];
    if (lit > MAX_LITRES) return [null, `${fmt(lit, 1)} litres in one refuelling is not possible (limit ${MAX_LITRES}).`];
    if (pr === null || pr <= 0) return [null, "Price per litre must be greater than 0."];
    if (receipt !== null && receipt !== undefined && String(receipt).trim() !== "" && (rec === null || rec < 0)) return [null, "Receipt total must be a number (0 or more), or left empty."];
    return [{ odo, litres: lit, price: pr, receipt: rec }, null];
  }
  function odometerIssues(vehicleId, when, odo, excludeId) {
    const rows = db.fuel.filter(f => f.vehicle_id === vehicleId && f.fill_id !== excludeId).sort(byKey("fill_datetime", "fill_id"));
    const before = rows.filter(r => r.fill_datetime <= when), after = rows.filter(r => r.fill_datetime > when);
    const prev = before[before.length - 1], next = after[0], issues = [];
    if (prev && odo <= prev.odometer_km) issues.push(`Odometer ${odo.toLocaleString("en-US")} km is not higher than the previous reading (${prev.odometer_km.toLocaleString("en-US")} km on ${prev.fill_datetime}).`);
    if (next && odo >= next.odometer_km) issues.push(`Odometer ${odo.toLocaleString("en-US")} km is not lower than the next reading (${next.odometer_km.toLocaleString("en-US")} km on ${next.fill_datetime}).`);
    if (prev && odo - prev.odometer_km > MAX_PLAUSIBLE_KM) issues.push(`${(odo - prev.odometer_km).toLocaleString("en-US")} km since the previous refuelling is more than ${MAX_PLAUSIBLE_KM.toLocaleString("en-US")} km.`);
    return issues;
  }
  function receiptNote(c) {
    if (c.receipt === null) return "";
    const total = c.litres * c.price, diff = c.receipt - total;
    return Math.abs(diff) > Math.max(S.tolAbs, S.tolPct * total) ? ` Warning: the receipt total differs from litres x price (${fmt(total)}) by ${diff >= 0 ? "+" : ""}${fmt(diff)}.` : " Receipt total matches.";
  }
  const duplicate = (vid, when, odo, exclude) => db.fuel.some(f => f.vehicle_id === vid && f.fill_datetime === when && f.odometer_km === odo && f.fill_id !== exclude);

  function addFill(d) {
    const v = db.vehicles.find(x => x.vehicle_id === d.vehicle_id);
    if (!v) return fail("Choose a vehicle from the list.");
    if (!v.active) return fail("This vehicle is inactive. Reactivate it on the Vehicles page first.");
    const when = stamp(d.date, d.time), [c, err] = cleanFill(when, d.odometer, d.litres, d.price, d.receipt);
    if (err) return fail(err);
    const issues = odometerIssues(v.vehicle_id, when, c.odo, null);
    if (issues.length && !d.confirm) return confirmMsg(issues.join(" ") + " Correct the value, or tick 'Confirm' to save it anyway.");
    if (duplicate(v.vehicle_id, when, c.odo, null)) return fail("This refuelling (same vehicle, time and odometer) is already recorded.");
    db.fuel.push({ fill_id: db.nextFill++, vehicle_id: v.vehicle_id, fill_datetime: when, odometer_km: c.odo, litres: c.litres, price_per_litre: c.price,
                   receipt_total: c.receipt, station: String(d.station || "").trim().slice(0, 60), odometer_confirmed: issues.length ? 1 : 0 });
    save();
    return ok(`Refuelling saved. Calculated total: ${fmt(c.litres * c.price)}.` + receiptNote(c));
  }
  function updateFill(id, d) {
    const row = db.fuel.find(f => f.fill_id === id);
    if (!row) return fail("Record not found.");
    const when = stamp(d.date, d.time), [c, err] = cleanFill(when, d.odometer, d.litres, d.price, d.receipt);
    if (err) return fail(err);
    const issues = odometerIssues(row.vehicle_id, when, c.odo, id);
    if (issues.length && !d.confirm) return confirmMsg(issues.join(" ") + " Correct the value, or tick 'Confirm' to save it anyway.");
    if (duplicate(row.vehicle_id, when, c.odo, id)) return fail("Another record with the same vehicle, time and odometer already exists.");
    Object.assign(row, { fill_datetime: when, odometer_km: c.odo, litres: c.litres, price_per_litre: c.price, receipt_total: c.receipt,
                         station: String(d.station || "").trim().slice(0, 60), odometer_confirmed: issues.length ? 1 : 0 });
    save();
    return ok("Refuelling updated." + receiptNote(c));
  }
  function deleteFill(id) {
    const n = db.fuel.length; db.fuel = db.fuel.filter(f => f.fill_id !== id); save();
    return db.fuel.length < n ? ok("Refuelling deleted.") : fail("Record not found.");
  }

  // ---------------------------------------------------------------- vehicles
  function cleanVehicle(d) {
    const reg = String(d.registration || "").trim();
    if (!reg) return [null, "Registration is required."];
    if (reg.length > 20) return [null, "Registration is too long (20 characters at most)."];
    const fuel = String(d.fuel_type || "").trim();
    if (fuel && !FUEL_TYPES.includes(fuel)) return [null, "Choose a fuel type from the list."];
    return [{ registration: reg, make_model: String(d.make_model || "").trim().slice(0, 60), vehicle_type: String(d.vehicle_type || "").trim().slice(0, 40), fuel_type: fuel,
              driver: String(d.driver || "").trim().slice(0, 60), notes: String(d.notes || "").trim().slice(0, 300) }, null];
  }
  function addVehicle(d) {
    const vid = String(d.vehicle_id || "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,12}$/.test(vid)) return fail("Vehicle ID: use 1-12 letters, digits, '-' or '_' (for example V07).");
    const [c, err] = cleanVehicle(d); if (err) return fail(err);
    if (db.vehicles.some(v => v.vehicle_id === vid || v.registration.toLowerCase() === c.registration.toLowerCase())) return fail("This Vehicle ID or registration already exists.");
    db.vehicles.push({ vehicle_id: vid, ...c, active: 1 }); save();
    return ok(`Vehicle ${vid} added.`);
  }
  function updateVehicle(vid, d) {
    const v = db.vehicles.find(x => x.vehicle_id === vid); if (!v) return fail("Vehicle not found.");
    const [c, err] = cleanVehicle(d); if (err) return fail(err);
    if (db.vehicles.some(x => x.vehicle_id !== vid && x.registration.toLowerCase() === c.registration.toLowerCase())) return fail("Another vehicle already has this registration.");
    Object.assign(v, c, { active: d.active ? 1 : 0 }); save();
    return ok(`Vehicle ${vid} updated.`);
  }
  function setActive(vid, active) {
    const v = db.vehicles.find(x => x.vehicle_id === vid); if (!v) return fail("Vehicle not found.");
    v.active = active ? 1 : 0; save();
    return ok(`Vehicle ${vid} is now ${active ? "active" : "inactive (its history is kept)"}.`);
  }

  // ---------------------------------------------------------------- maintenance and other expenses
  function addMaintenance(d) {
    if (!db.vehicles.some(v => v.vehicle_id === d.vehicle_id)) return fail("Choose a vehicle from the list.");
    if (!isDate(d.date)) return fail("Choose a valid date.");
    if (d.date > today()) return fail("Date cannot be in the future.");
    if (!CATEGORIES.includes(d.category)) return fail("Choose a category from the list.");
    const cost = num(d.cost); if (cost === null || cost < 0) return fail("Cost must be a number (0 or more).");
    const odo = num(d.odometer);
    if (d.odometer !== null && d.odometer !== undefined && String(d.odometer).trim() !== "" && (odo === null || odo < 0 || !Number.isInteger(odo))) return fail("Odometer must be a whole number of km, or left empty.");
    const desc = String(d.description || "").trim().slice(0, 120);
    if (db.maint.some(m => m.vehicle_id === d.vehicle_id && m.maint_date === d.date && m.category === d.category && m.description === desc && m.cost === cost)) return fail("The same expense is already recorded.");
    db.maint.push({ maint_id: db.nextMaint++, vehicle_id: d.vehicle_id, maint_date: d.date, category: d.category, description: desc, cost, odometer_km: odo, notes: String(d.notes || "").trim().slice(0, 300) }); save();
    return ok(`${d.category} expense of ${fmt(cost)} saved.`);
  }
  function deleteMaintenance(id) {
    const n = db.maint.length; db.maint = db.maint.filter(m => m.maint_id !== id); save();
    return db.maint.length < n ? ok("Expense deleted.") : fail("Record not found.");
  }

  // ---------------------------------------------------------------- request router (same addresses as a server would have)
  function handle(method, url, body) {
    const u = new URL(url, "http://local"), p = u.pathname, q = u.searchParams, d = body || {};
    const start = isDate(q.get("start")) ? q.get("start") : null, end = isDate(q.get("end")) ? q.get("end") : null, ids = q.getAll("vehicle").filter(Boolean);
    let m;
    if (p === "/api/meta") return { fuel_types: FUEL_TYPES, categories: CATEGORIES, today: today(), limits: { max_plausible_km: MAX_PLAUSIBLE_KM, max_litres: MAX_LITRES }, settings: S };
    if (p === "/api/counts") return { vehicles: db.vehicles.length, fuel_log: db.fuel.length, maintenance: db.maint.length };

    if (p === "/api/vehicles" && method === "GET") {
      const fuel = fuelFrame(), latest = latestReadings(fuel);
      return [...db.vehicles].sort(byKey("vehicle_id")).map(v => ({ ...v, last_odometer: latest[v.vehicle_id] ? latest[v.vehicle_id].km : null,
        last_fill: latest[v.vehicle_id] ? latest[v.vehicle_id].at : null, fills: fuel.filter(r => r.vehicle_id === v.vehicle_id).length }));
    }
    if (p === "/api/vehicles" && method === "POST") return addVehicle(d);
    if ((m = p.match(/^\/api\/vehicles\/([^/]+)\/active$/)) && method === "POST") return setActive(decodeURIComponent(m[1]), !!d.active);
    if ((m = p.match(/^\/api\/vehicles\/([^/]+)$/)) && method === "PUT") return updateVehicle(decodeURIComponent(m[1]), d);

    if (p === "/api/fuel" && method === "GET") {
      let rows = filterFuel(fuelFrame(), start, end, ids);
      if (q.get("flagged") === "1") rows = rows.filter(r => r.data_check !== "OK" || r.alert !== "");
      rows.sort((a, b) => -byKey("fill_datetime", "fill_id")(a, b));
      const limit = Math.max(1, Math.min(Number(q.get("limit")) || 500, 2000));
      return { total: rows.length, rows: rows.slice(0, limit) };
    }
    if (p === "/api/fuel" && method === "POST") return addFill(d);
    if ((m = p.match(/^\/api\/fuel\/(\d+)$/))) return method === "PUT" ? updateFill(Number(m[1]), d) : method === "DELETE" ? deleteFill(Number(m[1])) : fail("Not found.");

    if (p === "/api/maintenance" && method === "GET") {
      const rows = filterMaint(maintFrame(), start, end, ids, q.get("category") || null), by = {};
      rows.forEach(r => { by[r.category] = (by[r.category] || 0) + r.cost; });
      return { rows, total: rows.reduce((t, r) => t + r.cost, 0), by_category: by };
    }
    if (p === "/api/maintenance" && method === "POST") return addMaintenance(d);
    if ((m = p.match(/^\/api\/maintenance\/(\d+)$/)) && method === "DELETE") return deleteMaintenance(Number(m[1]));

    if (p === "/api/dashboard") {
      const veh = [...db.vehicles].sort(byKey("vehicle_id")), fuelAll = fuelFrame(), maintAll = maintFrame();
      const sel = ids.filter(i => veh.some(v => v.vehicle_id === i));
      const fuel = filterFuel(fuelAll, start, end, sel), maint = filterMaint(maintAll, start, end, sel);
      const summary = vehicleSummary(fuel, maint, sel.length ? veh.filter(v => sel.includes(v.vehicle_id)) : veh);
      const dates = fuelAll.map(r => r.fill_date).sort();
      return { kpis: kpis(fuel, maint, summary), summary, trend: monthlyTrend(fuel, maint),
               attention: fuel.filter(r => r.data_check !== "OK" || r.alert !== "").sort((a, b) => -byKey("fill_datetime", "fill_id")(a, b)).slice(0, 8),
               span: { first: dates[0] || null, last: dates[dates.length - 1] || null } };
    }
    return fail("Not found.");
  }

  // ---------------------------------------------------------------- export, reset
  const csvCell = v => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const toCsv = (head, rows) => [head.join(","), ...rows.map(r => r.map(csvCell).join(","))].join("\r\n");
  const r2 = v => (v === null ? "" : Math.round(v * 100) / 100);
  function fuelCsv() {
    const rows = fuelFrame().sort(byKey("fill_datetime", "vehicle_id"));
    return toCsv(["Date and time", "Vehicle", "Registration", "Driver", "Odometer (km)", "Litres", "Price per litre", "Total cost (calculated)", "Receipt total", "Receipt check", "Km driven", "Km per litre", "Cost per km", "Station", "Data check", "Alert"],
      rows.map(r => [r.fill_datetime, r.vehicle_id, r.registration, r.driver, r.odometer_km, r.litres, r.price_per_litre, r2(r.total_cost), r.receipt_total, r.receipt_check, r.km_driven, r2(r.km_per_litre), r2(r.cost_per_km), r.station, r.data_check, r.alert]));
  }
  function maintCsv() {
    return toCsv(["Date", "Vehicle", "Registration", "Category", "Description", "Cost", "Odometer (km)", "Notes"],
      maintFrame().map(m => [m.maint_date, m.vehicle_id, m.registration, m.category, m.description, m.cost, m.odometer_km, m.notes]));
  }
  function summaryCsv() {
    const fuel = fuelFrame(), maint = maintFrame();
    return toCsv(["Vehicle", "Registration", "Make / model", "Driver", "Active", "Refuellings", "Litres", "Fuel cost", "Km (valid)", "Km per litre", "Cost per km", "Maintenance", "Total running cost"],
      vehicleSummary(fuel, maint, [...db.vehicles].sort(byKey("vehicle_id"))).map(s => [s.vehicle_id, s.registration, s.make_model, s.driver, s.active ? "yes" : "no", s.fills, r2(s.litres), r2(s.fuel_cost), s.valid_km, r2(s.km_per_litre), r2(s.cost_per_km), r2(s.maintenance), r2(s.running_cost)]));
  }
  function reset(empty) {
    db = empty ? { vehicles: [], fuel: [], maint: [], nextFill: 1, nextMaint: 1 } : seed(); save();
    return ok(empty ? "All data deleted." : "Demo data restored.");
  }
  return { handle, fuelCsv, maintCsv, summaryCsv, reset };
})();
