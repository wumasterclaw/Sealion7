/*
 * Road-trip planner logic: geocoding, routing, charger search along a route,
 * charger classification and charging-stop planning.
 * Pure logic + network calls to public services. Never talks to the car.
 *
 * Services (all free, fair-use):
 *   Nominatim (OpenStreetMap) - place search, max 1 request / second
 *   OSRM demo server          - driving route
 *   Open Charge Map API v3    - charger locations (needs a free API key)
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const OCM = 'https://api.openchargemap.io/v3/poi';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = 6371; // km
const rad = (d) => (d * Math.PI) / 180;

/* ================================ Geometry ================================ */
export function haversine(a, b) {
  const dLat = rad(b[0] - a[0]); const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Route as [[lat, lon], ...] plus cumulative km at each vertex. */
export function buildRoute(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  return { points, cum, km: cum[cum.length - 1] };
}

/** Distance (km) from p to the route and the km-along-route of the closest point. */
export function project(route, p) {
  const { points, cum } = route;
  const kx = 111.32 * Math.cos(rad(p[0])); const ky = 110.57;
  let best = { d: Infinity, s: 0 };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]; const b = points[i];
    const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
    const bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
    const dx = bx - ax, dy = by - ay; const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0; t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy; const d = Math.sqrt(x * x + y * y);
    if (d < best.d) best = { d, s: cum[i - 1] + t * (cum[i] - cum[i - 1]) };
  }
  return best;
}

/** Keep at most `max` points (simple decimation, always keeps the ends). */
export function thin(points, max = 2000) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

/** Split the route into ~chunkKm pieces and return padded bounding boxes. */
export function corridorBoxes(route, corridorKm, chunkKm = 150) {
  const boxes = []; let cur = null; let startS = 0;
  const pad = (box) => {
    const midLat = (box.n + box.s) / 2; const dLat = corridorKm / 110.57; const dLon = corridorKm / (111.32 * Math.cos(rad(midLat)));
    return { n: box.n + dLat, s: box.s - dLat, e: box.e + dLon, w: box.w - dLon };
  };
  route.points.forEach((p, i) => {
    if (!cur) { cur = { n: p[0], s: p[0], e: p[1], w: p[1] }; startS = route.cum[i]; }
    cur.n = Math.max(cur.n, p[0]); cur.s = Math.min(cur.s, p[0]); cur.e = Math.max(cur.e, p[1]); cur.w = Math.min(cur.w, p[1]);
    if (route.cum[i] - startS >= chunkKm || i === route.points.length - 1) { boxes.push(pad(cur)); cur = { n: p[0], s: p[0], e: p[1], w: p[1] }; startS = route.cum[i]; }
  });
  return boxes;
}

/* ============================ Network services ============================ */
let lastGeocode = 0;
export async function geocode(q) {
  const wait = 1100 - (Date.now() - lastGeocode); if (wait > 0) await sleep(wait); // Nominatim: max 1 req/s
  lastGeocode = Date.now();
  const url = `${NOMINATIM}?format=jsonv2&countrycodes=au&limit=5&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Place search failed (${r.status})`);
  const list = await r.json();
  if (!list.length) throw new Error(`Couldn't find "${q}" in Australia`);
  return list.map((x) => ({ name: x.display_name.split(',').slice(0, 3).join(','), lat: Number(x.lat), lon: Number(x.lon) }));
}

export async function route(stops) {
  const coords = stops.map((s) => `${s.lon.toFixed(5)},${s.lat.toFixed(5)}`).join(';');
  const r = await fetch(`${OSRM}${coords}?overview=full&geometries=geojson&steps=false`);
  if (!r.ok) throw new Error(`Routing failed (${r.status})`);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error(`No driving route found (${j.code || 'unknown'})`);
  const rt = j.routes[0];
  return { points: rt.geometry.coordinates.map(([lon, lat]) => [lat, lon]), km: rt.distance / 1000, seconds: rt.duration };
}

export async function chargersAlong(rt, { key, corridorKm, onProgress = () => {} }) {
  if (!key) throw new Error('Add your Open Charge Map API key in Tools → Settings first');
  const boxes = corridorBoxes(rt, corridorKm);
  const seen = new Map();
  for (let i = 0; i < boxes.length; i++) {
    onProgress(i + 1, boxes.length);
    const b = boxes[i];
    const qs = new URLSearchParams({ output: 'json', countrycode: 'AU', maxresults: '1000', compact: 'false', verbose: 'false',
      boundingbox: `(${b.n.toFixed(4)},${b.w.toFixed(4)}),(${b.s.toFixed(4)},${b.e.toFixed(4)})`, key });
    const r = await fetch(`${OCM}?${qs}`, { headers: { Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) throw new Error('Open Charge Map rejected the API key. Check it in Tools → Settings');
    if (!r.ok) throw new Error(`Charger search failed (${r.status})`);
    for (const p of await r.json()) if (p && p.ID != null && !seen.has(p.ID)) seen.set(p.ID, normalise(p));
    if (i < boxes.length - 1) await sleep(250);
  }
  return [...seen.values()];
}

/* ========================== Charger classification ======================== */
export function connKind(title = '') {
  const t = title.toLowerCase();
  if (/ccs|combo/.test(t)) return /type ?1|combo ?1|j1772/.test(t) ? 'ccs1' : 'ccs2';
  if (/chademo/.test(t)) return 'chademo';
  if (/tesla|nacs/.test(t)) return 'tesla';
  if (/type ?2|mennekes|iec 62196/.test(t)) return 'type2';
  if (/3112|australia|as\/nzs|type i\b|domestic|caravan|cee|iec 60309|commando|3[- ]?phase|blue|red 5/.test(t)) return 'outlet';
  if (/type ?1|j1772/.test(t)) return 'type1';
  return 'other';
}

export const CATEGORIES = {
  ultra: { label: 'Ultra-fast DC (150 kW+)', short: 'Ultra DC', color: '#a78bfa', usable: true, dc: true },
  fast: { label: 'Fast DC (50-149 kW)', short: 'Fast DC', color: '#3aa8ff', usable: true, dc: true },
  dcslow: { label: 'Slow DC (under 50 kW)', short: 'Slow DC', color: '#2dd4bf', usable: true, dc: true },
  ac: { label: 'AC Type 2 (destination)', short: 'AC', color: '#f472b6', usable: true, dc: false },
  outlet: { label: 'Power outlet (portable charger)', short: 'Outlet', color: '#d4d4d8', usable: true, dc: false },
  incompatible: { label: 'Not compatible with Sealion 7', short: 'No CCS2/Type 2', color: '#52525b', usable: false, dc: false },
};

export function normalise(p) {
  const a = p.AddressInfo || {};
  const conns = (p.Connections || []).map((c) => ({
    type: c.ConnectionType?.Title || 'Unknown connector', kind: connKind(c.ConnectionType?.Title || ''),
    kw: c.PowerKW ?? null, qty: c.Quantity ?? null, current: c.CurrentType?.Title || '',
    operational: c.StatusType ? c.StatusType.IsOperational !== false : null,
  }));
  const ccs = conns.filter((c) => c.kind === 'ccs2');
  const maxKw = (list) => list.reduce((m, c) => Math.max(m, c.kw ?? 0), 0) || null;
  let category;
  if (ccs.length) { const kw = maxKw(ccs) ?? 50; category = kw >= 150 ? 'ultra' : kw >= 50 ? 'fast' : 'dcslow'; }
  else if (conns.some((c) => c.kind === 'type2')) category = 'ac';
  else if (conns.some((c) => c.kind === 'outlet')) category = 'outlet';
  else category = 'incompatible';
  const usage = p.UsageType?.Title || '';
  const cost = p.UsageCost || '';
  return {
    id: p.ID, name: a.Title || 'Charging location',
    address: [a.AddressLine1, a.Town, a.StateOrProvince].filter(Boolean).join(', '),
    lat: a.Latitude, lon: a.Longitude,
    operator: p.OperatorInfo?.Title && !/unknown/i.test(p.OperatorInfo.Title) ? p.OperatorInfo.Title : 'Unknown network',
    operatorUrl: p.OperatorInfo?.WebsiteURL || '',
    usage, cost, free: /free/i.test(cost) || /free/i.test(usage),
    restricted: /private|restricted/i.test(usage) && !/public/i.test(usage),
    operational: p.StatusType ? p.StatusType.IsOperational !== false : true,
    status: p.StatusType?.Title || 'Unknown status',
    points: p.NumberOfPoints ?? null,
    verified: p.DateLastVerified || p.DateLastStatusUpdate || null,
    conns, category,
    dcKw: ccs.length ? maxKw(ccs) : null,
    acKw: maxKw(conns.filter((c) => c.kind === 'type2')),
  };
}

/** Attach distance-from-route and km-along-route, drop anything outside the corridor. */
export function placeOnRoute(rt, chargers, corridorKm) {
  return chargers
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map((c) => { const pr = project(rt, [c.lat, c.lon]); return { ...c, offKm: pr.d, atKm: pr.s }; })
    .filter((c) => c.offKm <= corridorKm)
    .sort((a, b) => a.atKm - b.atKm);
}

/* ============================== Stop planning ============================= */
/**
 * Greedy plan: drive as far as is safe, prefer faster chargers near that limit,
 * charge to `chargeTo` % (100 % only where the next gap needs it), and on the
 * final stop add only what's needed to arrive with the reserve.
 */
export function plan(rt, chargers, o) {
  const kwhPerKm = (o.consumption * (1 + o.bufferPct / 100)) / 100;
  const pctPerKm = (kwhPerKm / o.usableKwh) * 100;
  const rangeKm = (pct) => Math.max(0, pct) / pctPerKm;
  const total = rt.km;
  const kmToMin = (km) => (rt.seconds && total ? (rt.seconds / total) * km / 60 : km / 80 * 60);
  const cands = chargers.filter((c) => CATEGORIES[c.category].dc && c.operational && !c.restricted);
  const powerOf = (c) => Math.min(c.dcKw ?? 50, o.carDcKw);

  const stops = []; const legs = []; const warnings = [];
  let pos = 0; let soc = o.startSoc; let extra = 0; let guard = 0; let clock = 0;

  while (guard++ < 60) {
    const toDest = total - pos + extra;
    const arriveDest = soc - toDest * pctPerKm;
    if (arriveDest >= o.reserve) {
      legs.push({ fromKm: pos, toKm: total, km: toDest, arrive: arriveDest, ok: 'good' });
      clock += kmToMin(toDest);
      return finish(arriveDest);
    }
    const reach = (c) => soc - (c.atKm - pos + extra + c.offKm) * pctPerKm;
    const ahead = cands.filter((c) => c.atKm > pos + 1);
    const reachable = ahead.filter((c) => reach(c) >= o.reserve);
    let pick; let ok = 'good';
    if (reachable.length) {
      const far = reachable[reachable.length - 1];
      // go as far as is safe, but step back up to 40 km for a charger at least 1.5x faster
      pick = far;
      for (const c of reachable) if (c.atKm >= far.atKm - 40 && powerOf(c) >= powerOf(pick) * 1.5) pick = c;
    } else if (ahead.length) {
      pick = ahead[0]; ok = 'bad';
      warnings.push(`Gap of ${Math.round(pick.atKm - pos)} km to the next compatible DC charger (${pick.name}). Your safe range is about ${Math.round(rangeKm(soc - o.reserve))} km. Plan an AC or outlet stop, or slow down.`);
    } else {
      ok = 'bad';
      warnings.push(`No compatible DC charger for the last ${Math.round(total - pos)} km. Your safe range is about ${Math.round(rangeKm(soc - o.reserve))} km. Look for AC or outlet options near the destination.`);
      legs.push({ fromKm: pos, toKm: total, km: toDest, arrive: arriveDest, ok });
      clock += kmToMin(toDest);
      return finish(arriveDest);
    }
    const legKm = pick.atKm - pos + extra + pick.offKm;
    const arrive = soc - legKm * pctPerKm;
    if (ok === 'good' && arrive < o.reserve + 5) ok = 'warn';
    legs.push({ fromKm: pos, toKm: pick.atKm, km: legKm, arrive, ok });
    clock += kmToMin(legKm);

    // how much to charge here
    const needDest = o.reserve + (total - pick.atKm + pick.offKm) * pctPerKm;
    const nextFrom = (pct) => cands.some((c) => c.atKm > pick.atKm + 1 && pct - (c.atKm - pick.atKm + pick.offKm + c.offKm) * pctPerKm >= o.reserve);
    let target; let note = '';
    const topUp = Math.max(o.chargeTo, 90); // a bit past the usual limit beats one more stop
    if (needDest + 3 <= topUp) { target = Math.ceil(needDest + 3); note = 'Enough to reach your destination'; }
    else if (nextFrom(o.chargeTo)) target = o.chargeTo;
    else { target = 100; note = needDest <= 100 ? 'Charge to 100 % to reach your destination' : 'Long gap ahead: charge to 100 %'; }
    target = Math.max(target, Math.ceil(Math.max(arrive, 0)));
    const mins = chargeMinutes(Math.max(arrive, 0), target, powerOf(pick), o.usableKwh);
    stops.push({ charger: pick, arrive, depart: target, mins, kwh: ((target - Math.max(arrive, 0)) / 100) * o.usableKwh, note, ok, etaMin: clock });
    clock += mins;
    pos = pick.atKm; soc = target; extra = pick.offKm;
  }
  warnings.push('Planning stopped after too many stops. Check the route.');
  return finish(soc);

  function finish(arrival) {
    const driveMin = kmToMin(total) + stops.reduce((s, x) => s + kmToMin(x.charger.offKm * 2), 0);
    const chargeMin = stops.reduce((s, x) => s + x.mins, 0);
    return { stops, legs, warnings, arrival, driveMin, chargeMin, totalMin: driveMin + chargeMin, rangeFull: rangeKm(100), pctPerKm };
  }
}

/** Charging time with LFP taper: full power to 80 %, roughly 35 % of it above. */
export function chargeMinutes(from, to, kw, usableKwh) {
  if (to <= from) return 0;
  const k = (pct) => (pct / 100) * usableKwh;
  const lo = Math.max(0, Math.min(to, 80) - from); const hi = Math.max(0, to - Math.max(from, 80));
  return 3 + (k(lo) / (kw * 0.85) + k(hi) / (kw * 0.35)) * 60;
}
