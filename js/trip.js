/* Trip planner UI: map, filters, plan timeline, charger list, saved trips. */
import { geocode, route as getRoute, chargersAlong, buildRoute, placeOnRoute, plan, thin, CATEGORIES } from './planner.js';
import { SAMPLE } from './sample-trip.js';
import { normalise } from './planner.js';

export function initTrip(ctx) {
  const { store, settings, toast, log, esc, fmt } = ctx;
  const $ = (s, el = document) => el.querySelector(s);
  const store$ = { get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } } };

  const form = $('#tripForm');
  let state = null;      // { name, from, to, via, rt, chargers, sample }
  let result = null;     // plan()
  let map = null; let layers = null;
  const filters = { cats: new Set(['ultra', 'fast', 'dcslow', 'ac', 'outlet']), network: 'all', minKw: 0, freeOnly: false, hideOffline: false };

  /* ------------------------------------------------------------ inputs */
  const saved = store$.get('s7.tripInputs', {});
  for (const [k, d] of Object.entries({ startSoc: 90, reserve: 15, chargeTo: 80, bufferPct: 10, corridorKm: 5 })) form[k].value = saved[k] ?? d;
  ['from', 'via', 'to'].forEach((k) => { if (saved[k]) form[k].value = saved[k]; });
  const inputs = () => ({
    startSoc: clamp(+form.startSoc.value, 1, 100), reserve: clamp(+form.reserve.value, 0, 50), chargeTo: clamp(+form.chargeTo.value, 50, 100),
    bufferPct: clamp(+form.bufferPct.value, 0, 100), corridorKm: clamp(+form.corridorKm.value, 1, 50),
    consumption: settings.consumption, usableKwh: settings.usableKwh, carDcKw: settings.carDcKw || 150,
  });
  const persistInputs = () => store$.set('s7.tripInputs', { ...inputs(), from: form.from.value, via: form.via.value, to: form.to.value });
  ['startSoc', 'reserve', 'chargeTo', 'bufferPct'].forEach((k) => form[k].addEventListener('change', () => { persistInputs(); replan(); }));

  $('#btnSocFromCar').addEventListener('click', () => {
    const v = store.values.soc;
    if (v == null) { toast('No charge reading yet: connect to the car (or demo mode) first', true); return; }
    form.startSoc.value = Math.floor(v); persistInputs(); replan(); toast(`Start charge set to ${Math.floor(v)} % from the car`);
  });
  $('#btnMyLoc').addEventListener('click', () => {
    if (!navigator.geolocation) { toast('Location is not available in this browser', true); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      form.from.value = 'My location'; form.from.dataset.lat = p.coords.latitude; form.from.dataset.lon = p.coords.longitude;
    }, (e) => toast(`Couldn't get your location: ${e.message}`, true), { enableHighAccuracy: false, timeout: 15000 });
  });
  form.from.addEventListener('input', () => { delete form.from.dataset.lat; delete form.from.dataset.lon; });

  /* ------------------------------------------------------------ planning */
  const progress = (t) => { $('#tripProgress').textContent = t; };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btnPlan'); btn.disabled = true; persistInputs();
    try {
      const o = inputs();
      const place = async (field, label) => {
        if (field.dataset.lat) return { name: 'My location', lat: +field.dataset.lat, lon: +field.dataset.lon };
        progress(`Finding ${label}…`); const r = await geocode(field.value.trim()); return r[0];
      };
      const from = await place(form.from, 'start'); const via = form.via.value.trim() ? await place(form.via, 'via point') : null;
      const to = await place(form.to, 'destination');
      progress('Calculating the route…');
      const r = await getRoute([from, via, to].filter(Boolean));
      const rt = { ...buildRoute(thin(r.points, 4000)), seconds: r.seconds };
      progress('Searching for chargers along the route…');
      const raw = await chargersAlong(rt, { key: settings.ocmKey, corridorKm: o.corridorKm,
        onProgress: (i, n) => progress(`Searching for chargers along the route… (section ${i} of ${n})`) });
      state = { name: `${short(from.name)} → ${short(to.name)}`, from, to, via, rt, chargers: placeOnRoute(rt, raw, o.corridorKm), sample: false, at: Date.now() };
      log(`Trip planned: ${state.name}, ${fmt(rt.km)} km, ${state.chargers.length} chargers in corridor`);
      progress(`${fmt(rt.km)} km route · ${state.chargers.length} charging locations within ${o.corridorKm} km`);
      show();
    } catch (err) {
      progress('');
      toast(err.message.includes('Failed to fetch') ? 'No internet connection, or a service is down. Saved trips still work offline.' : err.message, true);
      log(`Trip planner: ${err.message}`, 'err');
    }
    btn.disabled = false;
  });

  $('#btnSample').addEventListener('click', () => {
    const o = inputs();
    const rt = { ...buildRoute(SAMPLE.points), seconds: SAMPLE.seconds };
    state = { name: 'Sydney → Melbourne (SAMPLE data)', from: SAMPLE.from, to: SAMPLE.to, via: null, rt,
      chargers: placeOnRoute(rt, SAMPLE.raw.map(normalise), Math.max(o.corridorKm, 5)), sample: true, at: Date.now() };
    progress('Sample trip loaded. The chargers are made-up examples, not real locations.');
    show();
  });

  function replan() {
    if (!state) return;
    result = plan(state.rt, state.chargers, inputs());
    renderPlan(); drawMap();
  }
  function show() { replan(); buildNetworkFilter(); renderList(); fitMap(); $('#btnSaveTrip').disabled = false; }

  /* ------------------------------------------------------------ map */
  function ensureMap() {
    if (map) return true;
    if (!window.L) { $('#tripMap').innerHTML = '<div class="map-fallback">The map couldn\'t load (offline?). The plan and charger list below still work.</div>'; return false; }
    map = L.map('tripMap', { zoomControl: true, attributionControl: true, preferCanvas: true }).setView([-28.5, 134], 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    layers = { route: L.layerGroup().addTo(map), chargers: L.layerGroup().addTo(map), stops: L.layerGroup().addTo(map) };
    return true;
  }
  function fitMap() {
    if (!ensureMap() || !state) return;
    map.fitBounds(L.latLngBounds(state.rt.points), { padding: [24, 24] });
  }
  const legColor = { good: '#18b85a', warn: '#fab219', bad: '#e5484d' };
  function drawMap() {
    if (!ensureMap() || !state) return;
    Object.values(layers).forEach((l) => l.clearLayers());
    const pts = state.rt.points; const cum = state.rt.cum;
    L.polyline(pts, { color: '#0b0f14', weight: 9, opacity: 0.6 }).addTo(layers.route);
    for (const leg of result.legs) {
      const seg = pts.filter((_, i) => cum[i] >= leg.fromKm - 0.5 && cum[i] <= leg.toKm + 0.5);
      if (seg.length > 1) L.polyline(seg, { color: legColor[leg.ok], weight: 5, opacity: 0.95 }).addTo(layers.route);
    }
    L.circleMarker(pts[0], { radius: 8, color: '#fff', weight: 3, fillColor: '#18b85a', fillOpacity: 1 }).bindTooltip('Start').addTo(layers.route);
    L.circleMarker(pts[pts.length - 1], { radius: 8, color: '#fff', weight: 3, fillColor: '#e5484d', fillOpacity: 1 }).bindTooltip('Destination').addTo(layers.route);
    for (const c of visible()) {
      const cat = CATEGORIES[c.category];
      L.circleMarker([c.lat, c.lon], { radius: c.category === 'ultra' ? 8 : c.category === 'incompatible' ? 4 : 6, color: '#0b0f14', weight: 2,
        fillColor: cat.color, fillOpacity: c.operational ? 0.95 : 0.3, dashArray: c.operational ? null : '3 3' })
        .bindPopup(() => popupHtml(c), { maxWidth: 300, autoPanPaddingTopLeft: [56, 16], autoPanPaddingBottomRight: [16, 16] }).addTo(layers.chargers);
    }
    result.stops.forEach((s, i) => {
      L.marker([s.charger.lat, s.charger.lon], { icon: L.divIcon({ className: '', html: `<span class="stop-pin" data-s="${s.ok}">${i + 1}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 1000 })
        .bindPopup(() => popupHtml(s.charger, s, i), { maxWidth: 300, autoPanPaddingTopLeft: [56, 16], autoPanPaddingBottomRight: [16, 16] }).addTo(layers.stops);
    });
  }
  ctx.onShow = () => { if (ensureMap()) { setTimeout(() => { map.invalidateSize(); if (state && !map._fitted) { fitMap(); map._fitted = true; } }, 50); } };

  /* ------------------------------------------------------------ filters */
  const chips = $('#catChips');
  chips.innerHTML = Object.entries(CATEGORIES).map(([k, c]) => `<button type="button" class="chip" data-cat="${k}" aria-pressed="${filters.cats.has(k)}">
    <i style="background:${c.color}"></i>${esc(c.short)}</button>`).join('');
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    const k = b.dataset.cat; filters.cats.has(k) ? filters.cats.delete(k) : filters.cats.add(k);
    b.setAttribute('aria-pressed', filters.cats.has(k)); refreshFilters();
  });
  $('#fNetwork').addEventListener('change', (e) => { filters.network = e.target.value; refreshFilters(); });
  $('#fMinKw').addEventListener('change', (e) => { filters.minKw = +e.target.value; refreshFilters(); });
  $('#fFree').addEventListener('change', (e) => { filters.freeOnly = e.target.checked; refreshFilters(); });
  $('#fOffline').addEventListener('change', (e) => { filters.hideOffline = e.target.checked; refreshFilters(); });
  function refreshFilters() { drawMap(); renderList(); }
  function buildNetworkFilter() {
    const nets = [...new Set(state.chargers.map((c) => c.operator))].sort();
    $('#fNetwork').innerHTML = '<option value="all">All networks</option>' + nets.map((n) => `<option>${esc(n)}</option>`).join('');
    filters.network = 'all';
  }
  function visible() {
    if (!state) return [];
    return state.chargers.filter((c) => filters.cats.has(c.category)
      && (filters.network === 'all' || c.operator === filters.network)
      && (!filters.minKw || (c.dcKw ?? c.acKw ?? 0) >= filters.minKw)
      && (!filters.freeOnly || c.free) && (!filters.hideOffline || c.operational));
  }

  /* ------------------------------------------------------------ rendering */
  const dur = (m) => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`);
  const pctS = (p, o) => (p < o.reserve ? 'bad' : p < o.reserve + 1 ? 'warn' : 'good');
  const kwText = (c) => (c.dcKw ? `${fmt(c.dcKw)} kW DC` : c.acKw ? `${fmt(c.acKw)} kW AC` : CATEGORIES[c.category].short);
  const navUrl = (c) => `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}`;
  const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '');

  function chargerHtml(c, stop) {
    const cat = CATEGORIES[c.category];
    const plugs = c.conns.map((x) => `<span class="plug${['ccs2', 'type2', 'outlet'].includes(x.kind) ? ' ok' : ''}">${esc(x.type)}${x.kw ? ` ${fmt(x.kw)} kW` : ''}${x.qty ? ` ×${x.qty}` : ''}</span>`).join('');
    const op = safeUrl(c.operatorUrl);
    return `<div class="ch-top"><span class="cat-dot" style="background:${cat.color}"></span><b>${esc(c.name)}</b></div>
      <div class="ch-sub">${esc(c.operator)} · ${esc(kwText(c))}${c.points ? ` · ${c.points} bay${c.points > 1 ? 's' : ''}` : ''}</div>
      <div class="ch-sub muted">${esc(c.address)}</div>
      <div class="ch-tags">
        ${c.operational ? '' : '<span class="pill" data-s="bad">Not operational</span>'}
        ${c.restricted ? '<span class="pill" data-s="warn">Private / restricted</span>' : ''}
        ${!cat.usable ? '<span class="pill" data-s="bad">No compatible plug</span>' : ''}
        ${c.free ? '<span class="tag free">Free</span>' : ''}
        <span class="tag">${fmt(c.atKm)} km from start</span><span class="tag">${c.offKm < 0.3 ? 'on route' : `${fmt(c.offKm, 1)} km off route`}</span>
      </div>
      <div class="plugs">${plugs}</div>
      ${c.cost ? `<div class="ch-sub muted">Cost: ${esc(c.cost)}</div>` : ''}${c.usage ? `<div class="ch-sub muted">${esc(c.usage)}</div>` : ''}
      ${stop ? '' : `<div class="ch-links"><a class="btn small" href="${navUrl(c)}" target="_blank" rel="noopener">Navigate</a>
        ${c.id > 0 ? `<a class="btn ghost small" href="https://openchargemap.org/site/poi/details/${encodeURIComponent(c.id)}" target="_blank" rel="noopener">Details</a>` : ''}
        ${op ? `<a class="btn ghost small" href="${esc(op)}" target="_blank" rel="noopener">Network</a>` : ''}</div>`}`;
  }
  function popupHtml(c, s, i) {
    const head = s ? `<div class="pop-stop">Stop ${i + 1}: arrive ${fmt(s.arrive)} %, charge to ${fmt(s.depart)} % · about ${dur(s.mins)}</div>` : '';
    return `<div class="pop">${head}${chargerHtml(c)}</div>`;
  }

  function renderPlan() {
    const o = inputs(); const p = result; const box = $('#planBody');
    const arriveS = pctS(p.arrival, o);
    const tight = p.legs.some((l) => l.ok === 'warn');
    $('#planPill').dataset.s = p.warnings.length ? 'bad' : tight ? 'warn' : 'good';
    $('#planPill').textContent = p.warnings.length ? 'Check gaps' : tight ? 'OK, some tight legs' : 'Plan OK';
    const tile = (label, value, unit = '', s = 'none') => `<div class="tile" data-s="${s}"><span class="t-label">${esc(label)}</span><span class="t-value"><span class="n">${value}</span><small>${esc(unit)}</small></span></div>`;
    const steps = [];
    steps.push(step('start', 'good', esc(short(state.from.name)), `Leave with ${fmt(o.startSoc)} %`));
    p.legs.forEach((leg, i) => {
      steps.push(`<li class="leg" data-s="${leg.ok}"><span>${fmt(leg.km)} km · about ${dur(legMin(leg))}</span><span class="pill" data-s="${leg.ok}">${leg.arrive < 0 ? 'Not enough charge' : `arrive ${fmt(leg.arrive)} %`}</span></li>`);
      const s = p.stops[i];
      if (s) steps.push(step(String(i + 1), s.ok, `${esc(s.charger.name)} <span class="muted">· ${esc(s.charger.operator)} · ${esc(kwText(s.charger))}</span>`,
        `Charge ${fmt(Math.max(s.arrive, 0))} → ${fmt(s.depart)} % (+${fmt(s.kwh, 1)} kWh) · about ${dur(s.mins)}${s.note ? ` · ${esc(s.note)}` : ''}`,
        `<a class="btn small" href="${navUrl(s.charger)}" target="_blank" rel="noopener">Navigate</a>`));
    });
    steps.push(step('end', arriveS, esc(short(state.to.name)), `Arrive with about ${fmt(p.arrival)} %`));
    box.innerHTML = `${state.sample ? '<div class="sample-note">SAMPLE DATA: these chargers are made-up examples to show how the planner works.</div>' : ''}
      <div class="stats">
        ${tile('Distance', fmt(state.rt.km), 'km')}
        ${tile('Charging stops', p.stops.length)}
        ${tile('Driving time', dur(p.driveMin))}
        ${tile('Charging time', dur(p.chargeMin))}
        ${tile('Total trip time', dur(p.totalMin))}
        ${tile('Arrival charge', fmt(p.arrival), '%', arriveS)}
        ${tile('Range on a full charge', fmt(p.rangeFull), 'km')}
        ${tile('Planning consumption', fmt(o.consumption * (1 + o.bufferPct / 100), 1), 'kWh/100 km')}
      </div>
      ${p.warnings.map((w) => `<div class="warn-box" data-s="bad"><b>✕</b><span>${esc(w)}</span></div>`).join('')}
      <ol class="timeline">${steps.join('')}</ol>
      <p class="note">Only working, public, CCS2 DC chargers are used for stops. Times are estimates (charging slows above 80 %). Check each charger in its network's app before you rely on it.</p>`;
  }
  function legMin(leg) { const r = state.rt; return r.seconds ? (r.seconds / r.km) * leg.km / 60 : leg.km / 80 * 60; }
  function step(mark, s, title, sub, action = '') {
    return `<li class="stop" data-s="${s}"><span class="mark">${mark === 'start' ? '●' : mark === 'end' ? '⚑' : mark}</span>
      <div><div class="st-title">${title}</div><div class="st-sub">${sub}</div></div>${action}</li>`;
  }

  function renderList() {
    const list = visible(); const all = state ? state.chargers.length : 0;
    $('#chargerCount').textContent = state ? `${list.length} of ${all} shown` : '';
    $('#chargerList').innerHTML = !state ? '<p class="muted small">Plan a trip (or load the sample) to list every charger along the way.</p>'
      : list.length ? list.slice(0, 400).map((c) => `<div class="ch" data-s="${!c.operational || !CATEGORIES[c.category].usable ? 'bad' : 'none'}">${chargerHtml(c)}</div>`).join('')
        : '<p class="muted small">No chargers match these filters.</p>';
  }

  /* ------------------------------------------------------------ saved trips */
  const savedKey = 's7.savedTrips';
  function renderSaved() {
    const list = store$.get(savedKey, []);
    $('#savedTrips').innerHTML = list.length ? list.map((t, i) => `<li><span><b>${esc(t.name)}</b><br><span class="muted small">${fmt(t.km)} km · ${t.count} chargers · saved ${new Date(t.at).toLocaleDateString()}</span></span>
      <span class="row tight"><button class="btn small" data-load="${i}">Open</button><button class="btn ghost small" data-del="${i}">Delete</button></span></li>`).join('')
      : '<li class="muted small">Saved trips appear here and work without signal, which is handy in the outback.</li>';
  }
  $('#btnSaveTrip').addEventListener('click', () => {
    if (!state) return;
    const list = store$.get(savedKey, []);
    const entry = { name: state.name, at: Date.now(), km: state.rt.km, count: state.chargers.length, sample: state.sample,
      from: state.from, to: state.to, via: state.via, points: thin(state.rt.points, 1500), seconds: state.rt.seconds, chargers: state.chargers, inputs: inputs() };
    list.unshift(entry); if (list.length > 10) list.length = 10;
    if (store$.set(savedKey, list)) { toast('Trip saved for offline use'); renderSaved(); } else toast('Phone storage is full: delete a saved trip first', true);
  });
  $('#savedTrips').addEventListener('click', (e) => {
    const list = store$.get(savedKey, []);
    if (e.target.dataset.del != null) { list.splice(+e.target.dataset.del, 1); store$.set(savedKey, list); renderSaved(); return; }
    if (e.target.dataset.load == null) return;
    const t = list[+e.target.dataset.load];
    const rt = { ...buildRoute(t.points), seconds: t.seconds };
    state = { name: t.name, from: t.from, to: t.to, via: t.via, rt, chargers: t.chargers, sample: t.sample, at: t.at };
    progress(`Opened saved trip from ${new Date(t.at).toLocaleString()}. Charger details may have changed since then.`);
    show(); window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  renderSaved();
  renderList();
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
const short = (n) => String(n).split(',')[0];
