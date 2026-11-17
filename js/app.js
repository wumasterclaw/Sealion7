import { Store, LiveSource, DemoSource, DECODE_TYPES } from './sources.js';
import { ElmBle } from './elm.js';
import { stdPidInfo, hex, nrcText } from './obd.js';
import { METRICS, BYD_PIDS, statusOf, describeDtc, dtcSeverity, VEHICLE } from './profile.js';
import { History, Sessions, Alerts, keepAwake, tripSummary, consumptionStatus } from './features.js';
import { initTrip } from './trip.js';

/* ------------------------------------------------------------------ helpers */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, dp = 0) => (v == null || Number.isNaN(v) ? '-' : Number(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const STATUS_LABEL = { good: 'Good', warn: 'Warning', bad: 'Fault', none: '' };
const SVGNS = 'http://www.w3.org/2000/svg';

const storage = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const settings = Object.assign(
  { refreshMs: 1000, usableKwh: VEHICLE.usableKwh, consumption: 18, extraModules: [], customPids: [],
    tripIdleMin: 5, ocmKey: '', carDcKw: 150, alerts: true, alertWarnings: false, alertSound: true, alertVibrate: true, keepAwake: true },
  storage.get('s7.settings', {}),
);
const saveSettings = () => storage.set('s7.settings', settings);

const store = new Store();
let source = null;
const history = new History();
const sessions = new Sessions(store, settings, history);
const alerts = new Alerts(store, settings, history, (level, title, detail) => showAlert(level, title, detail));
let lastFaults = null;
const dataLog = [];

/* ------------------------------------------------------------------ console + toast */
const consoleEl = $('#console');
function log(msg, kind = '') {
  const line = document.createElement('div');
  if (kind) line.className = kind === 'io' ? 'io' : kind === 'warn' ? 'warn' : kind === 'err' ? 'err' : '';
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  consoleEl.appendChild(line);
  while (consoleEl.childElementCount > 600) consoleEl.firstChild.remove();
  consoleEl.scrollTop = consoleEl.scrollHeight;
}
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

/* ------------------------------------------------------------------ tabs */
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${b.dataset.tab}`));
  storage.set('s7.tab', b.dataset.tab);
  if (b.dataset.tab === 'trip') tripCtx.onShow?.();
  render();
}));

/* ------------------------------------------------------------------ number tween */
const tweens = new WeakMap();
function tween(el, to, dp) {
  const from = tweens.get(el) ?? to;
  tweens.set(el, to);
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to, dp); return; }
  const start = performance.now(); const dur = 600;
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur); const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e, dp);
    if (k < 1 && tweens.get(el) === to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ------------------------------------------------------------------ gauges */
function buildGauge(el) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 200 200');
  const arc = (cls) => {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', 100); c.setAttribute('cy', 100); c.setAttribute('r', 84);
    c.setAttribute('pathLength', 100); c.setAttribute('class', cls);
    c.setAttribute('transform', 'rotate(135 100 100)');
    c.setAttribute('stroke-dasharray', cls === 'g-track' ? '75 100' : '0 100');
    return c;
  };
  for (let i = 0; i <= 20; i++) {
    const a = (135 + i * 13.5) * Math.PI / 180; const major = i % 5 === 0;
    const r1 = 100, r2 = major ? 93 : 96;
    const l = document.createElementNS(SVGNS, 'line');
    l.setAttribute('x1', 100 + Math.cos(a) * r1); l.setAttribute('y1', 100 + Math.sin(a) * r1);
    l.setAttribute('x2', 100 + Math.cos(a) * r2); l.setAttribute('y2', 100 + Math.sin(a) * r2);
    l.setAttribute('class', `g-tick${major ? ' major' : ''}`);
    svg.appendChild(l);
  }
  svg.append(arc('g-track'), arc('g-val'));
  const center = document.createElement('div');
  center.className = 'g-center';
  center.innerHTML = '<span class="g-num">-</span><span class="g-unit"></span><span class="pill g-sub" data-s="none"></span>';
  el.append(svg, center);
  el.dataset.s = 'none';
}
$$('[data-gauge]').forEach(buildGauge);

function updateGauge(el) {
  const id = el.dataset.gauge; const m = METRICS[id]; const v = store.values[id];
  const min = Number(el.dataset.min); const max = Number(el.dataset.max);
  const s = statusOf(id, v);
  el.dataset.s = s;
  const num = $('.g-num', el); const val = $('.g-val', el); const pill = $('.g-sub', el);
  $('.g-unit', el).textContent = v == null ? missingText(id) : m.unit;
  if (v == null) { num.textContent = '-'; tweens.delete(num); val.setAttribute('stroke-dasharray', '0 100'); pill.textContent = ''; return; }
  tween(num, v, m.dp);
  const frac = Math.max(0, Math.min(1, (v - min) / (max - min)));
  val.setAttribute('stroke-dasharray', `${(frac * 75).toFixed(2)} 100`);
  pill.dataset.s = s; pill.textContent = STATUS_LABEL[s];
  el.classList.toggle('is-charging', id === 'soc' && !!store.info.charging);
}

function missingText(id) {
  const st = store.meta[id]?.state;
  if (!source) return 'waiting';
  if (id === 'soh' && !store.meta.soh) return 'not mapped yet';
  return { unsupported: 'not supported', implausible: 'check formula', nodata: 'no data' }[st] || 'waiting';
}

/* ------------------------------------------------------------------ metric tiles */
function updateMetric(el) {
  const id = el.dataset.metric; const m = METRICS[id]; if (!m) return;
  const v = store.values[id]; const s = statusOf(id, v);
  if (!el.firstChild) {
    el.innerHTML = '<span class="t-label"></span><span class="t-value"><span class="n">-</span><small></small></span><span class="pill" data-s="none"></span>';
    $('.t-label', el).textContent = m.label;
    if (m.help) el.title = m.help;
  }
  el.dataset.s = s;
  const n = $('.n', el); const valEl = $('.t-value', el);
  if (v == null) {
    valEl.classList.add('na'); n.textContent = '-'; tweens.delete(n);
    $('small', el).textContent = missingText(id);
  } else {
    valEl.classList.remove('na'); tween(n, v, m.dp); $('small', el).textContent = m.unit;
  }
  const pill = $('.pill', el); pill.dataset.s = s; pill.textContent = STATUS_LABEL[s];
}

function updatePill(el) {
  const id = el.dataset.pill; const s = statusOf(id, store.values[id]);
  el.dataset.s = s; el.textContent = STATUS_LABEL[s];
}

/* ------------------------------------------------------------------ special widgets */
function updateFlow() {
  const p = store.values.power; const fill = $('#flowFill'); const label = $('#flowLabel');
  if (p == null) { fill.style.width = '0'; label.textContent = 'No data'; return; }
  const zero = 37.5; const scale = 62.5 / 250; // % per kW (drive side); regen side 37.5/150 = same
  const w = Math.min(Math.abs(p) * scale, p >= 0 ? 62.5 : 37.5);
  fill.classList.toggle('regen', p < 0);
  fill.style.left = `${p >= 0 ? zero : zero - w}%`;
  fill.style.width = `${w}%`;
  label.textContent = Math.abs(p) < 0.5 ? 'Idle' : p > 0 ? `Discharging ${fmt(p, 1)} kW` : `${store.info.charging ? 'Charging' : 'Regenerating'} ${fmt(-p, 1)} kW`;
}

const tPos = (t) => Math.max(0, Math.min(100, ((t + 10) / 70) * 100));
function updateThermo() {
  const v = store.values; const mark = $('#thermoPack'); const range = $('#thermoRange');
  if (v.packTemp != null) { mark.style.display = 'block'; mark.style.left = `${tPos(v.packTemp)}%`; $('span', mark).textContent = `Pack ${fmt(v.packTemp)} °C`; }
  else mark.style.display = 'none';
  if (v.moduleLowTemp != null && v.moduleHighTemp != null) {
    range.style.display = 'block';
    range.style.left = `${tPos(v.moduleLowTemp)}%`;
    range.style.width = `${Math.max(1, tPos(v.moduleHighTemp) - tPos(v.moduleLowTemp))}%`;
    range.title = `Modules ${fmt(v.moduleLowTemp)}-${fmt(v.moduleHighTemp)} °C`;
  } else range.style.display = 'none';
}

function updateImbalance() {
  const d = store.values.cellDeltaMv; const i = $('#imbFill');
  i.style.width = d == null ? '0' : `${Math.min(100, (d / 120) * 100)}%`;
  i.parentElement.dataset.s = statusOf('cellDeltaMv', d);
  i.style.background = `var(--${{ good: 'good', warn: 'warn', bad: 'bad' }[statusOf('cellDeltaMv', d)] || 'none'})`;
}

/* ------------------------------------------------------------------ sparklines */
function buildSpark(el) {
  el.innerHTML = `<div class="spark-h"><span>${esc(el.dataset.label)}</span><b class="s-now">-</b></div>
    <svg viewBox="0 0 300 90" preserveAspectRatio="none" role="img" aria-label="${esc(el.dataset.label)} trend">
      <defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3aa8ff" stop-opacity=".35"/><stop offset="1" stop-color="#3aa8ff" stop-opacity="0"/></linearGradient></defs>
      <line class="s-zero" x1="0" x2="300"/><path class="s-area"/><path class="s-line" vector-effect="non-scaling-stroke"/>
      <line class="s-cross" y1="0" y2="90" vector-effect="non-scaling-stroke" style="display:none"/>
    </svg><div class="tip" style="display:none"></div>`;
  const svg = $('svg', el);
  const move = (e) => {
    const h = store.history[el.dataset.spark]; if (!h || h.length < 2) return;
    const r = svg.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const t0 = h[0].t, t1 = h[h.length - 1].t; const t = t0 + x * (t1 - t0);
    let best = h[0]; for (const p of h) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    const px = ((best.t - t0) / (t1 - t0 || 1)) * 300;
    const cross = $('.s-cross', el); cross.style.display = ''; cross.setAttribute('x1', px); cross.setAttribute('x2', px);
    const tip = $('.tip', el); tip.style.display = '';
    tip.style.left = `${Math.max(14, Math.min(86, (px / 300) * 100))}%`;
    tip.textContent = `${fmt(best.v, 1)} ${el.dataset.unit} · ${new Date(best.t).toLocaleTimeString()}`;
  };
  const leave = () => { $('.s-cross', el).style.display = 'none'; $('.tip', el).style.display = 'none'; };
  svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
}
$$('[data-spark]').forEach(buildSpark);

function updateSpark(el) {
  const h = store.history[el.dataset.spark] || [];
  $('.s-now', el).textContent = h.length ? `${fmt(h[h.length - 1].v, 1)} ${el.dataset.unit}` : '-';
  if (h.length < 2) { $('.s-line', el).setAttribute('d', ''); $('.s-area', el).setAttribute('d', ''); return; }
  let lo = Math.min(...h.map((p) => p.v)); let hi = Math.max(...h.map((p) => p.v));
  if (el.dataset.spark === 'power') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const t0 = h[0].t; const span = h[h.length - 1].t - t0 || 1;
  const X = (t) => ((t - t0) / span) * 300; const Y = (v) => 84 - ((v - lo) / (hi - lo)) * 78;
  const d = h.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  $('.s-line', el).setAttribute('d', d);
  $('.s-area', el).setAttribute('d', `${d}L300,90L0,90Z`);
  const z = $('.s-zero', el);
  if (lo < 0 && hi > 0) { z.style.display = ''; z.setAttribute('y1', Y(0)); z.setAttribute('y2', Y(0)); } else z.style.display = 'none';
}

/* ------------------------------------------------------------------ data tab */
function renderData() {
  const info = store.info;
  $('#infoList').innerHTML = [
    ['Vehicle', VEHICLE.name], ['Mode', source ? (source.kind === 'demo' ? 'Demo (simulated)' : 'Live') : 'Not connected'],
    ['Adapter', info.adapter || '-'], ['VIN', info.vin || '-'],
    ['Standard PIDs', info.supported ? info.supported.map((p) => hex(p)).join(' ') : '-'],
    ['Safety', 'Read-only allow-list enforced on every command'],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  const rows = BYD_PIDS.map((p) => ({ id: p.id, name: p.name, unit: p.unit, dp: p.dp, src: `22 ${p.did} @ ${VEHICLE.bmsHeader}`, conf: p.confidence }))
    .concat(settings.customPids.map((c) => ({ id: c.target || `custom_${c.header}_${c.did}`, name: c.name, unit: c.unit, dp: 2, src: `22 ${c.did} @ ${c.header}`, conf: 'Custom' })))
    .concat([{ id: 'aux12v', name: '12 V battery (adapter)', unit: 'V', dp: 2, src: 'ATRV', conf: 'Adapter measurement' }]);
  $('#bydTable').innerHTML = rows.map((r) => {
    const v = store.values[r.id]; const meta = store.meta[r.id] || {}; const s = statusOf(r.id, v);
    const val = v == null ? `<span class="muted">${esc(meta.state || 'waiting')}</span>` : `${fmt(v, r.dp)} ${esc(r.unit)}`;
    return `<tr><td>${esc(r.name)}</td><td class="num">${val}</td><td><span class="pill" data-s="${s}">${STATUS_LABEL[s]}</span></td><td class="mono">${esc(meta.raw || '')}</td><td class="mono">${esc(r.src)}<br><span class="muted">${esc(r.conf)}</span></td></tr>`;
  }).join('');

  const std = [...store.std.entries()].sort((a, b) => a[0] - b[0]);
  const sup = info.supported || [];
  $('#stdCount').textContent = sup.length ? `${sup.length} supported by the car` : '';
  const pids = [...new Set([...sup, ...std.map(([p]) => p)])].sort((a, b) => a - b);
  $('#stdTable').innerHTML = pids.length ? pids.map((pid) => {
    const r = store.std.get(pid); const inf = stdPidInfo(pid);
    const v = r ? (typeof r.value === 'number' ? `${fmt(r.value, Number.isInteger(r.value) ? 0 : 2)} ${inf.unit}` : esc(r.value)) : '<span class="muted">reading…</span>';
    return `<tr><td class="mono">01 ${hex(pid)}</td><td>${esc(inf.name)}</td><td class="num">${v}</td><td class="mono">${esc(r?.ecu || '')}</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="muted">Connect to list every standard PID the car supports.</td></tr>';
}

/* ------------------------------------------------------------------ render loop */
let rafPending = false;
function render() {
  if (rafPending) return; rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const active = $('.panel.active');
    const scopes = carOpen ? [$('#carMode')] : [active];
    scopes.forEach((sc) => {
      $$('[data-gauge]', sc).forEach(updateGauge);
      $$('[data-metric]', sc).forEach(updateMetric);
      $$('[data-pill]', sc).forEach(updatePill);
    });
    if (carOpen) { renderCar(); return; }
    if (active.id === 'tab-overview') { updateFlow(); $('#chargingBanner').classList.toggle('hidden', !store.info.charging); }
    if (active.id === 'tab-battery') { updateThermo(); updateImbalance(); $$('[data-spark]').forEach(updateSpark); }
    if (active.id === 'tab-data') renderData();
    if (active.id === 'tab-history') renderHistoryTab();
    if (store.info.vin) $('#vehicleSub').textContent = `Premium · ${store.info.vin}`;
  });
}

store.on(() => {
  sessions.update(source?.kind === 'demo');
  alerts.check();
  render();
  const v = store.values;
  dataLog.push({ t: new Date().toISOString(), ...Object.fromEntries(Object.keys(METRICS).map((k) => [k, v[k] == null ? '' : Number(v[k]).toFixed(3)])) });
  if (dataLog.length > 20000) dataLog.shift();
});

/* ------------------------------------------------------------------ connection */
const connEl = $('#connState');
function setConn(state, text) {
  connEl.dataset.state = state;
  $('span', connEl).textContent = text || { idle: 'Not connected', connecting: 'Connecting…', initialising: 'Initialising…', connected: source?.kind === 'demo' ? 'Demo mode' : 'Live', disconnected: 'Disconnected', error: 'Error' }[state];
  const on = state === 'connected' || state === 'initialising' || state === 'connecting';
  $('#btnConnect').classList.toggle('hidden', on); $('#btnDemo').classList.toggle('hidden', on);
  $('#btnDisconnect').classList.toggle('hidden', !on);
  if (state === 'disconnected') { sessions.finish(); keepAwake(false); source = null; render(); }
  if (state === 'connected' && settings.keepAwake) keepAwake(true);
}

async function start(kind) {
  if (source) { source.disconnect(); sessions.finish(); }
  store.reset(); lastFaults = null; renderFaults();
  sessions.reset(); alerts.reset();
  if (kind === 'demo') history.useDemo(); else history.useReal();
  lastLogKey = ''; histKey = '';
  source = kind === 'demo' ? new DemoSource(store, settings, log) : new LiveSource(store, settings, log);
  setConn('connecting');
  try {
    await source.connect((s) => setConn(s));
    toast(kind === 'demo' ? 'Demo mode: values are simulated' : 'Connected to adapter');
    render();
  } catch (e) {
    log(e.message, 'err');
    source = null;
    setConn(e.name === 'NotFoundError' ? 'idle' : 'error');
    if (e.name !== 'NotFoundError') toast(e.message, true);
  }
}

$('#btnConnect').addEventListener('click', () => start('live'));
$('#btnDemo').addEventListener('click', () => start('demo'));
$('#btnDisconnect').addEventListener('click', () => { source?.disconnect(); sessions.finish(); keepAwake(false); source = null; setConn('idle'); render(); });
if (!ElmBle.supported()) {
  $('#connectHint').innerHTML = 'This browser has no Web Bluetooth. Open this page in <b>Chrome on Android</b> (over HTTPS) to connect, or try demo mode.';
}

/* ------------------------------------------------------------------ faults */
$('#btnReadFaults').addEventListener('click', async () => {
  if (!source) { toast('Connect first (or start demo mode)', true); return; }
  const btn = $('#btnReadFaults'); btn.disabled = true;
  try {
    lastFaults = await source.readFaults((msg) => { $('#faultProgress').textContent = msg; });
    $('#faultProgress').textContent = `Read at ${new Date().toLocaleTimeString()}`;
    renderFaults();
    const f = lastFaults;
    alerts.faults([...f.stored, ...f.pending, ...f.permanent, ...f.modules.flatMap((m) => m.codes)].filter((d) => dtcSeverity(d) === 'bad'));
  } catch (e) { toast(`Fault read failed: ${e.message}`, true); log(e.message, 'err'); }
  btn.disabled = false;
});

function dtcCard(d) {
  const s = dtcSeverity(d);
  const label = { stored: 'Stored', pending: 'Pending', permanent: 'Permanent', history: 'History' }[d.kind] || d.kind;
  const extra = [d.ecu ? `ECU ${d.ecu}` : '', d.ftb ? `failure type 0x${d.ftb}` : '', d.status != null ? `status 0x${hex(d.status)}` : '', d.mil ? 'warning lamp requested' : ''].filter(Boolean).join(' · ');
  return `<div class="dtc" data-s="${s}"><span class="dtc-code">${esc(d.code)}</span><span class="dtc-desc">${esc(describeDtc(d.code))}</span>
    <span class="pill" data-s="${s}">${esc(label)}</span><span class="dtc-meta">${esc(extra)}</span></div>`;
}

function renderFaults() {
  const lists = $('#faultLists'); const mods = $('#moduleList');
  const badge = $('#faultBadge'); const tileV = $('#faultTileValue'); const tileP = $('#faultTilePill'); const tile = $('#faultTile');
  const mil = $('#milBanner');
  if (!lastFaults) {
    lists.innerHTML = ''; mods.innerHTML = '<p class="muted">Run a fault read to scan each control module.</p>';
    badge.classList.add('hidden'); tileV.textContent = 'Not read'; tileP.textContent = ''; tile.dataset.s = 'none';
    mil.dataset.s = 'none'; $('#milText').textContent = 'Not read yet'; return;
  }
  const f = lastFaults;
  const moduleCodes = f.modules.flatMap((m) => m.codes.map((c) => ({ ...c, module: m.name })));
  const all = [...f.stored, ...f.pending, ...f.permanent, ...moduleCodes];
  const worst = all.reduce((w, d) => { const s = dtcSeverity(d); return s === 'bad' || w === 'bad' ? 'bad' : s === 'warn' || w === 'warn' ? 'warn' : w; }, 'good');
  const milOn = store.info.mil || moduleCodes.some((c) => c.mil);
  mil.dataset.s = milOn ? 'bad' : worst;
  $('#milText').textContent = milOn ? 'Warning lamp ON: the car is reporting an active fault'
    : all.length ? `${all.length} code${all.length > 1 ? 's' : ''} found, warning lamp off` : 'No fault codes reported';
  const group = (title, items) => `<div class="fault-group"><h3>${title} (${items.length})</h3>${items.length ? items.map(dtcCard).join('') : '<div class="empty-ok">None</div>'}</div>`;
  lists.innerHTML = group('Stored (OBD2 mode 03)', f.stored) + group('Pending (mode 07)', f.pending)
    + group('Permanent (mode 0A)', f.permanent) + group('Module codes (UDS 19 02)', moduleCodes);
  mods.innerHTML = f.modules.map((m) => {
    const s = !m.responded ? 'none' : m.codes.some((c) => dtcSeverity(c) === 'bad') ? 'bad' : m.codes.length ? 'warn' : 'good';
    const txt = !m.responded ? 'No reply' : m.codes.length ? `${m.codes.length} code${m.codes.length > 1 ? 's' : ''}` : 'OK';
    return `<div class="module"><span><b>${esc(m.header)}</b>${esc(m.name)}</span><span class="pill" data-s="${s}">${txt}</span></div>`;
  }).join('');
  badge.textContent = all.length; badge.classList.toggle('hidden', !all.length);
  tile.dataset.s = all.length ? worst : 'good';
  tileV.innerHTML = `<span class="n">${all.length}</span><small>${all.length === 1 ? 'code' : 'codes'}</small>`;
  tileP.dataset.s = tile.dataset.s; tileP.textContent = STATUS_LABEL[tile.dataset.s];
}
renderFaults();

/* ------------------------------------------------------------------ settings */
const sForm = $('#settingsForm');
sForm.refreshMs.value = settings.refreshMs; sForm.usableKwh.value = settings.usableKwh;
sForm.consumption.value = settings.consumption; sForm.extraModules.value = settings.extraModules.join(', ');
sForm.tripIdleMin.value = settings.tripIdleMin;
sForm.ocmKey.value = settings.ocmKey; sForm.carDcKw.value = settings.carDcKw;
$('#btnShowKey').addEventListener('click', (e) => { const t = sForm.ocmKey.type === 'password'; sForm.ocmKey.type = t ? 'text' : 'password'; e.target.textContent = t ? 'Hide' : 'Show'; });
const CHECKS = ['alerts', 'alertWarnings', 'alertSound', 'alertVibrate', 'keepAwake'];
CHECKS.forEach((k) => { sForm[k].checked = !!settings[k]; });
sForm.addEventListener('submit', (e) => {
  e.preventDefault();
  settings.refreshMs = Math.max(250, Number(sForm.refreshMs.value) || 1000);
  settings.usableKwh = Number(sForm.usableKwh.value) || VEHICLE.usableKwh;
  settings.consumption = Number(sForm.consumption.value) || 18;
  settings.tripIdleMin = Math.max(1, Number(sForm.tripIdleMin.value) || 5);
  settings.ocmKey = sForm.ocmKey.value.trim();
  settings.carDcKw = Math.max(20, Number(sForm.carDcKw.value) || 150);
  CHECKS.forEach((k) => { settings[k] = sForm[k].checked; });
  keepAwake(!!source && settings.keepAwake);
  settings.extraModules = sForm.extraModules.value.split(/[\s,]+/).map((x) => x.toUpperCase()).filter((x) => /^[0-9A-F]{3}$/.test(x));
  sForm.extraModules.value = settings.extraModules.join(', ');
  saveSettings(); toast('Settings saved');
});

/* ------------------------------------------------------------------ custom PIDs */
const cForm = $('#customForm');
cForm.type.innerHTML = DECODE_TYPES.map((t) => `<option>${t}</option>`).join('');
cForm.target.innerHTML = '<option value="">Own row only (All data tab)</option>'
  + Object.entries(METRICS).map(([k, m]) => `<option value="${k}">${esc(m.label)}</option>`).join('');
function renderCustom() {
  $('#customList').innerHTML = settings.customPids.map((c, i) => `<li><span><b>${esc(c.name)}</b> <span class="mono">22 ${esc(c.did)} @ ${esc(c.header)} · ${esc(c.type)} ×${esc(c.scale)} +${esc(c.add)}</span></span>
    <button class="btn ghost small" data-del="${i}">Remove</button></li>`).join('') || '<li class="muted">No custom PIDs yet.</li>';
}
renderCustom();
cForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(cForm));
  settings.customPids.push({ ...f, header: f.header.toUpperCase(), did: f.did.toUpperCase(), fast: !!f.fast });
  saveSettings(); renderCustom(); cForm.reset(); toast('Custom PID added');
});
$('#customList').addEventListener('click', (e) => {
  const i = e.target.dataset.del; if (i == null) return;
  settings.customPids.splice(Number(i), 1); saveSettings(); renderCustom();
});

/* ------------------------------------------------------------------ discovery scan */
const scanForm = $('#scanForm'); let scanStop = false; let scanRows = [];
scanForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!source) { toast('Connect first (or start demo mode)', true); return; }
  const header = scanForm.header.value.toUpperCase();
  const from = parseInt(scanForm.from.value, 16); const to = parseInt(scanForm.to.value, 16);
  if (!(to >= from) || to - from > 4095) { toast('Range must be ascending and at most 4096 identifiers', true); return; }
  scanStop = false; scanRows = []; $('#scanTable').innerHTML = '';
  $('#btnScan').disabled = true; $('#btnScanStop').disabled = false;
  log(`Discovery scan ${header} 22${hex(from, 4)}-22${hex(to, 4)} started`);
  await source.scanDids(header, from, to, (did, r, n) => {
    $('#scanBar').style.width = `${((n - from + 1) / (to - from + 1)) * 100}%`;
    if (!r || !r.data) return;
    const d = r.data; const u16 = d.length >= 2 ? d[0] | (d[1] << 8) : '';
    scanRows.push({ header, did, bytes: d.map((x) => hex(x)).join(' ') });
    $('#scanTable').insertAdjacentHTML('beforeend', `<tr><td class="mono">${did}</td><td class="mono">${d.map((x) => hex(x)).join(' ')}</td><td>${d.length}</td><td class="mono">${d[0] ?? ''} / ${u16}</td></tr>`);
  }, () => scanStop);
  log(`Discovery scan finished: ${scanRows.length} identifiers answered`);
  $('#btnScan').disabled = false; $('#btnScanStop').disabled = true;
});
$('#btnScanStop').addEventListener('click', () => { scanStop = true; });

function downloadCsv(name, rows) {
  if (!rows.length) { toast('Nothing to export yet', true); return; }
  const cols = Object.keys(rows[0]);
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#btnScanCsv').addEventListener('click', () => downloadCsv(`sealion7-scan-${Date.now()}.csv`, scanRows));
$('#btnLogCsv').addEventListener('click', () => downloadCsv(`sealion7-log-${Date.now()}.csv`, dataLog));
$('#btnClearLog').addEventListener('click', () => { consoleEl.innerHTML = ''; });

/* ------------------------------------------------------------------ alerts UI */
function showAlert(level, title, detail) {
  const el = document.createElement('div');
  el.className = 'alert'; el.dataset.s = level; el.setAttribute('role', 'alert');
  el.innerHTML = `<span class="a-icon">${level === 'bad' ? '✕' : '!'}</span><span class="a-title">${esc(title)}</span>
    <button aria-label="Dismiss">×</button><span class="a-detail">${esc(detail)}</span>`;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  $('button', el).addEventListener('click', close);
  $('#alertStack').prepend(el);
  while ($('#alertStack').childElementCount > 3) $('#alertStack').lastChild.remove();
  if (level !== 'bad') setTimeout(close, 12000); // red alerts stay until dismissed
  log(`ALERT: ${title} ${detail}`, level === 'bad' ? 'err' : 'warn');
}
$('#btnTestAlert').addEventListener('click', () => alerts.fire('bad', 'Test alert', 'This is how a red alert looks, sounds and feels.'));

/* ------------------------------------------------------------------ car mode */
let carOpen = false;
async function setCarMode(on) {
  carOpen = on;
  $('#carMode').classList.toggle('hidden', !on);
  document.body.classList.toggle('car-open', on);
  try {
    if (on) {
      if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (screen.orientation?.lock) await screen.orientation.lock('landscape').catch(() => {});
    } else {
      if (screen.orientation?.unlock) screen.orientation.unlock();
      if (document.fullscreenElement) await document.exitFullscreen();
    }
  } catch { /* fullscreen not allowed: car mode still works in the page */ }
  if (on) keepAwake(true); else keepAwake(!!source && settings.keepAwake);
  render();
}
$('#btnCarMode').addEventListener('click', () => setCarMode(true));
$('#btnCarExit').addEventListener('click', () => setCarMode(false));
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && carOpen) setCarMode(false); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (carOpen || (source && settings.keepAwake))) keepAwake(true); });

function renderCar() {
  const v = store.values;
  const sp = $('#cmSpeed');
  if (v.speed == null) { sp.textContent = '-'; tweens.delete(sp); } else tween(sp, v.speed, 0);
  const st = $('#cmStatus');
  const faults = lastFaults ? [...lastFaults.stored, ...lastFaults.pending, ...lastFaults.permanent, ...lastFaults.modules.flatMap((m) => m.codes)] : [];
  const red = Object.keys(METRICS).filter((k) => statusOf(k, v[k]) === 'bad').map((k) => METRICS[k].label);
  if (!source) { st.dataset.s = 'none'; st.textContent = 'Not connected'; }
  else if (red.length) { st.dataset.s = 'bad'; st.textContent = `✕ Check: ${red.join(', ')}`; }
  else if (faults.length) { st.dataset.s = faults.some((d) => dtcSeverity(d) === 'bad') ? 'bad' : 'warn'; st.textContent = `! ${faults.length} fault code${faults.length > 1 ? 's' : ''}`; }
  else if (store.info.charging && sessions.charge) {
    st.dataset.s = 'good';
    const eta = sessions.eta(80);
    st.textContent = `⚡ Charging · +${fmt(sessions.charge.addedKwh, 1)} kWh${eta != null ? ` · 80% in ${dur(eta)}` : ''}`;
  } else { st.dataset.s = 'good'; st.textContent = '✓ All systems normal'; }
}

/* ------------------------------------------------------------------ history tab */
const dur = (mins) => (mins == null ? '-' : mins < 60 ? `${Math.round(mins)} min` : `${Math.floor(mins / 60)} h ${String(Math.round(mins % 60)).padStart(2, '0')} min`);
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function stat(label, value, unit = '', s = 'none', pillText) {
  return `<div class="tile" data-s="${s}"><span class="t-label">${esc(label)}</span>
    <span class="t-value${value === '-' ? ' na' : ''}"><span class="n">${value}</span><small>${esc(unit)}</small></span>
    ${s !== 'none' ? `<span class="pill" data-s="${s}">${esc(pillText || STATUS_LABEL[s])}</span>` : ''}</div>`;
}
const EMPTY_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16v.5"/></svg>';
const effLabel = { good: 'Efficient', warn: 'Average', bad: 'High use' };

let lastLogKey = '';
function renderHistoryTab() {
  const v = store.values;
  /* charging session */
  const c = sessions.charge; const cp = $('#chargePill');
  if (c) {
    const kw = c.samples.length ? c.samples[c.samples.length - 1].kw : 0;
    const mins = (Date.now() - c.start) / 60000;
    cp.dataset.s = 'good'; cp.textContent = 'Charging';
    const soc = v.soc ?? c.endSoc ?? 0; const st = c.startSoc ?? soc;
    $('#chargeBody').innerHTML = `
      <div class="charge-bar"><div class="cb-start" style="width:${st}%"></div><div class="cb-fill" style="left:${st}%;width:${Math.max(0, soc - st)}%"></div>
        <div class="cb-mark" style="left:80%"><span>80%</span></div><div class="cb-mark" style="left:calc(100% - 2px)"><span>100%</span></div></div>
      <div class="stats">
        ${stat('Charging power', fmt(kw, 1), 'kW')}
        ${stat('Energy added', fmt(c.addedKwh, 2), 'kWh')}
        ${stat('Peak power', fmt(c.peakKw, 1), 'kW')}
        ${stat('Average power', fmt(c.addedKwh / Math.max(mins / 60, 10 / 3600), 1), 'kW')}
        ${stat('Charge', `${fmt(st)}→${fmt(soc)}`, '%')}
        ${stat('Elapsed', dur(mins))}
        ${stat('Time to 80 %', soc >= 80 ? 'done' : dur(sessions.eta(80)))}
        ${stat('Time to 100 %', dur(sessions.eta(100)))}
      </div><p class="note">Times are estimates from the last 3 minutes of charging power. LFP batteries charge more slowly above about 80 %.</p>`;
  } else {
    cp.dataset.s = 'none'; cp.textContent = '';
    $('#chargeBody').innerHTML = `<div class="empty-state">${EMPTY_ICON}<span>Not charging. When the car starts charging (connected and ready), a live session appears here with power, energy added and time to 80 % / 100 %.</span></div>`;
  }

  /* current trip */
  const t = sessions.trip;
  if (t) {
    const sum = tripSummary(t); const es = consumptionStatus(sum.kwh100);
    $('#tripBody').innerHTML = `<div class="stats">
      ${stat('Distance', fmt(sum.distKm, 1), 'km')}
      ${stat('Driving time', dur(t.movingMs / 60000))}
      ${stat('Energy used', fmt(sum.usedKwh, 2), 'kWh')}
      ${stat('Regen recovered', fmt(sum.regenKwh, 2), 'kWh')}
      ${stat('Consumption', sum.kwh100 == null ? '-' : fmt(sum.kwh100, 1), 'kWh/100 km', es, effLabel[es])}
      ${stat('Average speed', sum.avgSpeed == null ? '-' : fmt(sum.avgSpeed), 'km/h')}
      ${stat('Top speed', fmt(sum.maxSpeed), 'km/h')}
      ${stat('Charge used', sum.startSoc != null && sum.endSoc != null ? fmt(sum.startSoc - sum.endSoc, 1) : '-', '%')}
    </div>`;
  } else {
    $('#tripBody').innerHTML = `<div class="empty-state">${EMPTY_ICON}<span>No trip in progress. A trip starts automatically when the car moves and ends after ${settings.tripIdleMin} minutes stopped, or when charging starts.</span></div>`;
  }
  $('#btnEndTrip').disabled = !t;

  /* logs */
  const H = history.data;
  const logKey = `${H.trips.length}|${H.trips[0]?.start}|${H.charges.length}|${H.charges[0]?.start}|${H.alerts.length}|${H.alerts[0]?.t}|${history.persist}`;
  if (logKey === lastLogKey) { drawHistory(); return; }
  lastLogKey = logKey;
  const demoTag = (x) => (x.demo ? '<span class="badge-demo">DEMO</span>' : '');
  $('#tripCount').textContent = H.trips.length ? `${H.trips.length} saved` : '';
  $('#tripList').innerHTML = H.trips.length ? H.trips.slice(0, 100).map((x) => {
    const es = consumptionStatus(x.kwh100);
    return `<div class="log" data-s="${es}"><span class="l-title">${fmt(x.distKm, 1)} km · ${x.kwh100 == null ? '-' : fmt(x.kwh100, 1)} kWh/100 km${demoTag(x)}</span>
      <span class="l-when">${when(x.start)}</span>
      <span class="l-detail">${dur((x.end - x.start) / 60000)} · used ${fmt(x.usedKwh, 1)} kWh · regen ${fmt(x.regenKwh, 1)} kWh · avg ${x.avgSpeed == null ? '-' : fmt(x.avgSpeed)} km/h${x.startSoc != null && x.endSoc != null ? ` · ${fmt(x.startSoc)}→${fmt(x.endSoc)} %` : ''}</span></div>`;
  }).join('') : '<p class="muted small">Trips are saved automatically when they end.</p>';
  $('#chargeCount').textContent = H.charges.length ? `${H.charges.length} saved` : '';
  $('#chargeList').innerHTML = H.charges.length ? H.charges.slice(0, 100).map((x) => {
    const dc = x.peakKw > 22;
    return `<div class="log" data-s="good"><span class="l-title">+${fmt(x.addedKwh, 1)} kWh · ${dc ? 'DC fast' : 'AC'}${demoTag(x)}</span>
      <span class="l-when">${when(x.start)}</span>
      <span class="l-detail">${dur((x.end - x.start) / 60000)} · avg ${fmt(x.avgKw, 1)} kW · peak ${fmt(x.peakKw, 1)} kW${x.startSoc != null && x.endSoc != null ? ` · ${fmt(x.startSoc)}→${fmt(x.endSoc)} %` : ''}</span></div>`;
  }).join('') : '<p class="muted small">Charging sessions are saved automatically when they end.</p>';
  $('#alertList').innerHTML = H.alerts.length ? H.alerts.slice(0, 50).map((a) => `<div class="log" data-s="${a.level}">
      <span class="l-title">${esc(a.title)}</span><span class="l-when">${when(a.t)}</span><span class="l-detail">${esc(a.detail)}</span></div>`).join('')
    : '<p class="muted small">No alerts yet.</p>';
  drawHistory();
}

/* long-term chart */
const HIST_METRICS = ['soh', 'cellDeltaMv', 'packTemp', 'moduleHighTemp', 'aux12v', 'soc', 'odometer'];
$('#histMetric').innerHTML = HIST_METRICS.map((k) => `<option value="${k}">${esc(METRICS[k].label)}</option>`).join('');
$('#histMetric').value = storage.get('s7.histMetric', 'soh');
['histMetric', 'histRange'].forEach((id) => $(`#${id}`).addEventListener('change', () => { storage.set('s7.histMetric', $('#histMetric').value); histKey = ''; drawHistory(); }));
let histKey = '';
function drawHistory() {
  const metric = $('#histMetric').value; const days = Number($('#histRange').value); const m = METRICS[metric];
  const snaps = history.data.snapshots;
  const key = `${metric}|${days}|${snaps.length}|${snaps[snaps.length - 1]?.t}|${history.persist}`;
  if (key === histKey) return; histKey = key;
  const from = days ? Date.now() - days * 86400000 : 0;
  const raw = snaps.filter((s) => s.t >= from && s[metric] != null);
  const box = $('#histChart');
  $('#histInfo').textContent = `${snaps.length.toLocaleString()} snapshots saved${history.persist ? ' on this phone' : ' (demo sample data)'} · 1 per minute while connected`;
  if (raw.length < 2) { box.innerHTML = `<div class="empty">Not enough data yet for ${esc(m.label)}. History builds up automatically every minute you're connected.</div>`; return; }
  // daily aggregation (min / mean / max) for long ranges, raw points for short ones
  const spanDays = (raw[raw.length - 1].t - raw[0].t) / 86400000;
  let pts;
  if (spanDays > 2) {
    const byDay = new Map();
    raw.forEach((s) => { const d = new Date(s.t); d.setHours(12, 0, 0, 0); const k = d.getTime(); const a = byDay.get(k) || []; a.push(s[metric]); byDay.set(k, a); });
    pts = [...byDay].map(([t, a]) => ({ t, v: a.reduce((x, y) => x + y, 0) / a.length, lo: Math.min(...a), hi: Math.max(...a), n: a.length }));
  } else pts = raw.map((s) => ({ t: s.t, v: s[metric], lo: s[metric], hi: s[metric], n: 1 }));
  let lo = Math.min(...pts.map((p) => p.lo)); let hi = Math.max(...pts.map((p) => p.hi));
  const pad = (hi - lo) * 0.1 || Math.max(0.5, Math.abs(hi) * 0.01); lo -= pad; hi += pad;
  const W = 600, Hh = 200; const t0 = pts[0].t, t1 = pts[pts.length - 1].t; const span = t1 - t0 || 1;
  const X = (t) => ((t - t0) / span) * W; const Y = (v) => Hh - ((v - lo) / (hi - lo)) * Hh;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const band = spanDays > 2 ? pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.hi).toFixed(1)}`).join('')
    + pts.slice().reverse().map((p) => `L${X(p.t).toFixed(1)},${Y(p.lo).toFixed(1)}`).join('') + 'Z' : '';
  const ticks = [0, 0.5, 1].map((f) => lo + (hi - lo) * f);
  const dateFmt = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="${esc(m.label)} history">
      ${ticks.map((v) => `<line class="h-grid" x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" vector-effect="non-scaling-stroke"/>`).join('')}
      ${band ? `<path class="h-band" d="${band}"/>` : ''}
      <path class="h-line" d="${line}" vector-effect="non-scaling-stroke"/>
      <line class="h-cross" y1="0" y2="${Hh}" vector-effect="non-scaling-stroke" style="display:none"/>
    </svg>
    ${ticks.map((v) => `<span class="h-y" style="top:calc(10px + ${(Y(v) / Hh) * 200}px)">${fmt(v, m.dp)}</span>`).join('')}
    <div class="h-x"><span>${dateFmt(t0)}</span><span>${esc(m.label)} (${esc(m.unit)})${spanDays > 2 ? ' · daily average, shaded = daily range' : ''}</span><span>${dateFmt(t1)}</span></div>
    <div class="tip" style="display:none"></div>`;
  const svg = $('svg', box); const cross = $('.h-cross', box); const tip = $('.tip', box);
  const move = (e) => {
    const r = svg.getBoundingClientRect(); const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const t = t0 + x * span; let best = pts[0]; for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    const px = X(best.t); cross.style.display = ''; cross.setAttribute('x1', px); cross.setAttribute('x2', px);
    tip.style.display = ''; const plotW = box.clientWidth - 56; tip.style.left = `${44 + Math.max(0.12, Math.min(0.88, px / W)) * plotW}px`;
    tip.textContent = `${spanDays > 2 ? dateFmt(best.t) : new Date(best.t).toLocaleTimeString()} · ${fmt(best.v, m.dp)} ${m.unit}${best.n > 1 ? ` (range ${fmt(best.lo, m.dp)}-${fmt(best.hi, m.dp)})` : ''}`;
  };
  svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', () => { cross.style.display = 'none'; tip.style.display = 'none'; });
}
$('#btnEndTrip').addEventListener('click', () => { sessions.endTrip(); toast('Trip saved'); histKey = ''; lastLogKey = ''; render(); });
$('#btnHistCsv').addEventListener('click', () => {
  const H = history.data;
  downloadCsv(`sealion7-history-${Date.now()}.csv`, H.snapshots.map((s) => ({ time: new Date(s.t).toISOString(), ...s })));
  if (H.trips.length) downloadCsv(`sealion7-trips-${Date.now()}.csv`, H.trips.map((x) => ({ ...x, start: new Date(x.start).toISOString(), end: new Date(x.end).toISOString() })));
  if (H.charges.length) downloadCsv(`sealion7-charges-${Date.now()}.csv`, H.charges.map((x) => ({ ...x, start: new Date(x.start).toISOString(), end: new Date(x.end).toISOString() })));
});
$('#btnHistClear').addEventListener('click', () => {
  if (!history.persist) { toast('Demo data is not saved; disconnect demo mode to manage your real history', true); return; }
  if (!confirm('Delete all saved history, trips, charging sessions and alerts from this phone? This cannot be undone.')) return;
  history.clear(); histKey = ''; lastLogKey = ''; render(); toast('Saved history cleared');
});

/* ------------------------------------------------------------------ trip planner */
const tripCtx = { store, settings, toast, log, esc, fmt };
initTrip(tripCtx);

/* ------------------------------------------------------------------ boot */
const savedTab = storage.get('s7.tab', 'overview');
$(`.tabs button[data-tab="${savedTab}"]`)?.click();
render();
log('Sealion 7 dashboard ready. Read-only guard active.');
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (new URLSearchParams(location.search).has('demo')) start('demo');

export { nrcText };
