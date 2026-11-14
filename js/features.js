/*
 * Trips, charging sessions, alerts, saved history and screen wake lock.
 * Everything here only reads values from the Store; nothing talks to the car.
 */
import { statusOf, METRICS } from './profile.js';

/* =============================== History =============================== */
const KEY = 's7.history';
const LIMITS = { snapshots: 10000, trips: 500, charges: 500, alerts: 200 };
const empty = () => ({ snapshots: [], trips: [], charges: [], alerts: [] });

export class History {
  constructor() {
    this.persist = true;
    this.data = this.load();
  }
  load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && Array.isArray(d.snapshots)) return { ...empty(), ...d };
    } catch { /* ignore */ }
    return empty();
  }
  save() {
    if (!this.persist) return;
    const write = () => localStorage.setItem(KEY, JSON.stringify(this.data));
    try { write(); } catch {
      // storage full: drop the oldest quarter of snapshots and retry once
      this.data.snapshots.splice(0, Math.ceil(this.data.snapshots.length / 4));
      try { write(); } catch { /* give up quietly */ }
    }
  }
  /** Demo mode uses an in-memory, pre-filled history so real logs are never touched. */
  useDemo() { if (!this.real) this.real = this.data; this.persist = false; this.data = demoHistory(); }
  useReal() { if (this.real) { this.data = this.real; this.real = null; } this.persist = true; }
  snapshot(s) {
    const a = this.data.snapshots; a.push(s);
    if (a.length > LIMITS.snapshots) a.splice(0, a.length - LIMITS.snapshots);
    this.save();
  }
  add(kind, item) {
    const a = this.data[kind]; a.unshift(item);
    if (a.length > LIMITS[kind]) a.length = LIMITS[kind];
    this.save();
  }
  clear() { this.data = empty(); this.save(); }
}

/* ======================== Trips & charging sessions ===================== */
export class Sessions {
  constructor(store, settings, history) {
    this.store = store; this.settings = settings; this.history = history;
    this.reset();
  }
  reset() {
    this.trip = null; this.charge = null; this.charging = false;
    this.candSince = null; this.offSince = null; this.lastT = null; this.lastSnap = 0;
  }

  update(isDemo) {
    const v = this.store.values; const now = Date.now();
    const dtH = this.lastT ? Math.min(5, (now - this.lastT) / 1000) / 3600 : 0;
    this.lastT = now;
    const p = v.power; const speed = v.speed;

    /* --- charging detection (demo tells us directly) --- */
    if (isDemo) this.charging = !!this.store.info.charging;
    else {
      const cand = p != null && (speed == null ? p < -3 : p < -1 && speed < 1);
      if (cand) { this.offSince = null; this.candSince ??= now; } else { this.candSince = null; this.offSince ??= now; }
      if (!this.charging && this.candSince && now - this.candSince > (speed == null ? 30000 : 10000)) this.charging = true;
      if (this.charging && this.offSince && now - this.offSince > 30000) this.charging = false;
      this.store.info.charging = this.charging;
    }

    /* --- charging session --- */
    if (this.charging) {
      if (!this.charge) this.charge = { start: now, startSoc: v.soc ?? null, addedKwh: 0, peakKw: 0, samples: [], demo: isDemo };
      const c = this.charge;
      if (p != null && p < 0) {
        c.addedKwh += -p * dtH; c.peakKw = Math.max(c.peakKw, -p);
        c.samples.push({ t: now, kw: -p });
        while (c.samples.length && now - c.samples[0].t > 180000) c.samples.shift();
      }
      c.endSoc = v.soc ?? c.endSoc; c.last = now;
    } else if (this.charge) this.endCharge();

    /* --- trip --- */
    const moving = speed != null ? speed > 0.5 : p != null && p > 2;
    if (moving && !this.trip && !this.charging) {
      this.trip = { start: now, startOdo: v.odometer ?? null, startSoc: v.soc ?? null, distKm: 0, usedKwh: 0, regenKwh: 0, maxSpeed: 0, movingMs: 0, lastMove: now, demo: isDemo };
    }
    if (this.trip) {
      const t = this.trip;
      if (t.startOdo != null && v.odometer != null) t.distKm = Math.max(0, v.odometer - t.startOdo);
      else if (speed != null) t.distKm += speed * dtH;
      if (p != null) { if (p > 0) t.usedKwh += p * dtH; else if (!this.charging) t.regenKwh += -p * dtH; }
      if (speed != null) t.maxSpeed = Math.max(t.maxSpeed, speed);
      if (moving) { t.lastMove = now; t.movingMs += dtH * 3600000; }
      t.endSoc = v.soc ?? t.endSoc;
      if (this.charging || now - t.lastMove > this.settings.tripIdleMin * 60000) this.endTrip();
    }

    /* --- long-term snapshot once a minute --- */
    if (now - this.lastSnap >= 60000) {
      this.lastSnap = now;
      const keys = ['soc', 'soh', 'packTemp', 'moduleHighTemp', 'cellDeltaMv', 'aux12v', 'odometer', 'totalChargedKwh', 'totalDischargedKwh'];
      const snap = { t: now };
      keys.forEach((k) => { if (v[k] != null) snap[k] = Math.round(v[k] * 100) / 100; });
      if (Object.keys(snap).length > 1) this.history.snapshot(snap);
    }
  }

  endCharge() {
    const c = this.charge; this.charge = null;
    if (!c || c.addedKwh < 0.1) return;
    const hours = Math.max(1 / 3600, ((c.last || Date.now()) - c.start) / 3600000);
    this.history.add('charges', { start: c.start, end: c.last || Date.now(), startSoc: c.startSoc, endSoc: c.endSoc,
      addedKwh: c.addedKwh, peakKw: c.peakKw, avgKw: c.addedKwh / hours, demo: c.demo });
  }

  endTrip() {
    const t = this.trip; this.trip = null;
    if (!t || t.distKm < 0.2) return;
    this.history.add('trips', tripSummary(t));
  }

  /** Called on disconnect: close open sessions so nothing is lost. */
  finish() { this.endCharge(); this.endTrip(); }

  /** Estimated minutes to reach target SOC. LFP charging tapers above ~80 %. */
  eta(target) {
    const c = this.charge; const soc = this.store.values.soc;
    if (!c || soc == null || soc >= target || c.samples.length < 3) return null;
    const kw = c.samples.reduce((s, x) => s + x.kw, 0) / c.samples.length;
    if (kw < 0.5) return null;
    const usable = this.settings.usableKwh;
    let mins = (Math.max(0, Math.min(target, 80) - soc) / 100) * usable / kw * 60;
    if (target > 80) mins += ((target - Math.max(80, soc)) / 100) * usable / (kw * (soc >= 80 ? 1 : 0.45)) * 60;
    return mins;
  }
}

export function tripSummary(t) {
  const net = t.usedKwh - t.regenKwh;
  return {
    start: t.start, end: t.lastMove ?? t.end, distKm: t.distKm, usedKwh: t.usedKwh, regenKwh: t.regenKwh, netKwh: net,
    kwh100: t.distKm >= 2 ? (net / t.distKm) * 100 : null,
    startSoc: t.startSoc, endSoc: t.endSoc, maxSpeed: t.maxSpeed,
    avgSpeed: t.movingMs > 0 ? t.distKm / (t.movingMs / 3600000) : null, demo: !!t.demo,
  };
}

export const consumptionStatus = (k) => (k == null ? 'none' : k <= 18 ? 'good' : k <= 24 ? 'warn' : 'bad');

/* ================================= Alerts ================================ */
const WATCH = ['soc', 'packTemp', 'moduleHighTemp', 'moduleLowTemp', 'tempSpread', 'cellDeltaMv', 'aux12v', 'coolant', 'soh'];
const LEVEL = { none: 0, good: 0, warn: 1, bad: 2 };

export class Alerts {
  constructor(store, settings, history, show) {
    this.store = store; this.settings = settings; this.history = history; this.show = show;
    this.prev = {}; this.last = {}; this.seenDtc = new Set();
  }
  reset() { this.prev = {}; this.last = {}; this.seenDtc = new Set(); }

  check() {
    if (!this.settings.alerts) return;
    const v = this.store.values; const now = Date.now();
    for (const id of WATCH) {
      const s = statusOf(id, v[id]); const lv = LEVEL[s]; const was = LEVEL[this.prev[id] || 'none'];
      this.prev[id] = s;
      if (lv <= was || lv === 0) continue;
      if (lv === 1 && !this.settings.alertWarnings) continue;
      if (now - (this.last[id] || 0) < 120000) continue; // max once per 2 minutes per value
      this.last[id] = now;
      const m = METRICS[id];
      const val = `${Number(v[id]).toFixed(m.dp)} ${m.unit}`.trim();
      this.fire(s, `${m.label}: ${val}`, m.help || '');
    }
  }

  faults(list) {
    if (!this.settings.alerts) return;
    const fresh = list.filter((d) => !this.seenDtc.has(d.code));
    list.forEach((d) => this.seenDtc.add(d.code));
    if (fresh.length) this.fire('bad', `${fresh.length} new fault code${fresh.length > 1 ? 's' : ''}`, fresh.map((d) => d.code).join(', '));
  }

  fire(level, title, detail) {
    this.history.add('alerts', { t: Date.now(), level, title, detail });
    this.show(level, title, detail);
    if (this.settings.alertVibrate && navigator.vibrate) {
      try { navigator.vibrate(level === 'bad' ? [300, 120, 300, 120, 300] : [200]); } catch { /* ignore */ }
    }
    if (this.settings.alertSound) beep(level);
  }
}

let audio;
export function beep(level) {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const tones = level === 'bad' ? [880, 660, 880] : [660];
    tones.forEach((f, i) => {
      const o = audio.createOscillator(); const g = audio.createGain();
      o.frequency.value = f; o.type = 'sine';
      const t0 = audio.currentTime + i * 0.22;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      o.connect(g).connect(audio.destination); o.start(t0); o.stop(t0 + 0.2);
    });
  } catch { /* audio unavailable */ }
}

/* ================================ Wake lock ============================== */
let lock = null;
export async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      if (!lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); }
    } else if (!on && lock) { await lock.release(); lock = null; }
  } catch { lock = null; }
}

/* ============================ Demo sample data =========================== */
function demoHistory() {
  const h = empty(); const now = Date.now(); const day = 86400000;
  let odo = 13200; let rnd = 7;
  const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  for (let i = 120; i >= 0; i -= 0.25) {
    const t = now - i * day; odo += 9 + rand() * 6;
    const season = Math.sin(((t / day) % 365) / 365 * Math.PI * 2);
    h.snapshots.push({ t, soc: 35 + rand() * 55, soh: 99.6 - (120 - i) * 0.015 + (rand() - 0.5) * 0.15,
      packTemp: 24 + season * 8 + rand() * 4, moduleHighTemp: 27 + season * 8 + rand() * 4,
      cellDeltaMv: 14 + rand() * 9 + (120 - i) * 0.02, aux12v: 12.55 + rand() * 0.25, odometer: odo });
  }
  for (let i = 0; i < 14; i++) {
    const start = now - (i * 2.3 + 0.4) * day; const dist = 6 + rand() * 70; const k = 14 + rand() * 9;
    const used = dist * k / 100 * 1.15; const regen = used - dist * k / 100;
    h.trips.push({ start, end: start + dist / 45 * 3600000, distKm: dist, usedKwh: used, regenKwh: regen, netKwh: used - regen,
      kwh100: k, startSoc: 80 - i, endSoc: 80 - i - dist * k / 100 / 82.5 * 100, maxSpeed: 60 + rand() * 50, avgSpeed: 35 + rand() * 30, demo: true });
  }
  for (let i = 0; i < 6; i++) {
    const start = now - (i * 5 + 1) * day; const added = 20 + rand() * 45; const avg = i % 3 === 0 ? 95 + rand() * 40 : 6.8 + rand() * 0.6;
    h.charges.push({ start, end: start + added / avg * 3600000, startSoc: 20 + rand() * 20, endSoc: 80 + rand() * 20, addedKwh: added,
      peakKw: avg * (i % 3 === 0 ? 1.35 : 1.02), avgKw: avg, demo: true });
  }
  return h;
}
