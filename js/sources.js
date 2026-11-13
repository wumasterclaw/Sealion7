import { ElmBle } from './elm.js';
import { ObdClient, stdPidInfo, hex, nrcText } from './obd.js';
import { BYD_PIDS, VEHICLE, MODULES } from './profile.js';

/* --------------------------------- Store --------------------------------- */
export class Store {
  constructor() {
    this.values = {};   // id -> number
    this.meta = {};     // id -> { raw, source, state, at }
    this.std = new Map(); // pid -> { value, raw, ecu }
    this.history = { power: [], packTemp: [], soc: [] };
    this.info = {};
    this.listeners = new Set();
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind) { this.listeners.forEach((fn) => fn(kind)); }
  set(id, value, meta = {}) {
    this.values[id] = value;
    this.meta[id] = { ...meta, state: 'ok', at: Date.now() };
  }
  mark(id, state, meta = {}) {
    this.meta[id] = { ...(this.meta[id] || {}), ...meta, state, at: Date.now() };
  }
  reset() {
    this.values = {}; this.meta = {}; this.std = new Map(); this.info = {};
    Object.keys(this.history).forEach((k) => (this.history[k] = []));
  }
  /** Values computed from raw readings. */
  derive(settings) {
    const v = this.values;
    if (v.packVoltage != null && v.packCurrent != null) v.power = (v.packVoltage * v.packCurrent) / 1000;
    if (v.cellMinMv != null && v.cellMaxMv != null) v.cellDeltaMv = v.cellMaxMv - v.cellMinMv;
    if (v.moduleHighTemp != null && v.moduleLowTemp != null) v.tempSpread = v.moduleHighTemp - v.moduleLowTemp;
    if (v.totalDischargedKwh != null) v.fullCycles = v.totalDischargedKwh / settings.usableKwh;
    if (v.soc != null) v.rangeEst = (v.soc / 100) * settings.usableKwh / settings.consumption * 100;
    const now = Date.now();
    for (const k of Object.keys(this.history)) {
      if (v[k] == null) continue;
      const h = this.history[k];
      h.push({ t: now, v: v[k] });
      while (h.length && now - h[0].t > 10 * 60 * 1000) h.shift(); // keep 10 minutes
    }
  }
}

/* ----------------------------- Custom PIDs ------------------------------- */
export const DECODE_TYPES = ['u8', 's8', 'u16le', 'u16be', 's16le', 's16be', 'u32le', 'u32be'];
export function decodeCustom(def, d) {
  const o = Number(def.offset) || 0;
  const b = (i) => d[o + i];
  const need = { u8: 1, s8: 1, u16le: 2, u16be: 2, s16le: 2, s16be: 2, u32le: 4, u32be: 4 }[def.type] || 1;
  if (d.length < o + need) return null;
  let n;
  switch (def.type) {
    case 'u8': n = b(0); break;
    case 's8': n = (b(0) << 24) >> 24; break;
    case 'u16le': n = b(0) | (b(1) << 8); break;
    case 'u16be': n = (b(0) << 8) | b(1); break;
    case 's16le': n = ((b(0) | (b(1) << 8)) << 16) >> 16; break;
    case 's16be': n = (((b(0) << 8) | b(1)) << 16) >> 16; break;
    case 'u32le': n = (b(0) | (b(1) << 8) | (b(2) << 16) | (b(3) << 24)) >>> 0; break;
    case 'u32be': n = ((b(0) << 24) | (b(1) << 16) | (b(2) << 8) | b(3)) >>> 0; break;
    default: return null;
  }
  return n * (Number(def.scale) || 1) + (Number(def.add) || 0);
}

const bytesHex = (d) => d.map((x) => hex(x)).join(' ');

/* ------------------------------ Live source ------------------------------ */
export class LiveSource {
  constructor(store, settings, log) {
    this.store = store;
    this.settings = settings;
    this.log = log;
    this.running = false;
    this.unsupported = new Map(); // key -> cycle when it failed
    this.kind = 'live';
  }

  async connect(onStatus) {
    this.elm = new ElmBle({ log: this.log });
    this.elm.onDisconnect = () => { this.running = false; onStatus('disconnected'); };
    await this.elm.connect();
    onStatus('initialising');
    this.obd = new ObdClient(this.elm, this.log);
    const id = await this.obd.init();
    this.store.info.adapter = `${this.elm.name} (${id})`;
    this.log(`Adapter ready: ${id}`);
    try { this.store.info.vin = await this.obd.vin(); } catch (e) { this.log(`VIN: ${e.message}`, 'warn'); }
    try {
      this.supported = await this.obd.supportedPids();
      this.store.info.supported = this.supported;
      this.log(`Standard PIDs supported: ${this.supported.map((p) => hex(p)).join(', ') || 'none'}`);
    } catch (e) { this.supported = []; this.log(`Supported PIDs: ${e.message}`, 'warn'); }
    onStatus('connected');
    this.running = true;
    this.loop();
  }

  disconnect() { this.running = false; this.elm && this.elm.disconnect(); }

  async loop() {
    let cycle = 0;
    let stdIdx = 0;
    while (this.running) {
      const started = Date.now();
      const slow = cycle % 5 === 0;
      try {
        if (!this.paused) {
          for (const p of BYD_PIDS) if (slow || !p.slow) await this.readByd(p, cycle);
          for (const c of this.settings.customPids) if (slow || c.fast) await this.readCustom(c, cycle);
          if (slow) {
            const v = await this.obd.batteryVoltage().catch(() => null);
            if (v != null) this.store.set('aux12v', v, { source: 'Adapter (ATRV)', raw: `${v} V` });
          }
          // standard PIDs: speed every cycle, the rest rotate 4 per cycle
          const sup = this.supported || [];
          const list = sup.includes(0x0d) ? [0x0d] : [];
          for (let i = 0; i < Math.min(4, sup.length); i++) list.push(sup[(stdIdx + i) % sup.length]);
          stdIdx += 4;
          for (const pid of new Set(list)) await this.readStd(pid);
          this.store.derive(this.settings);
          this.store.emit('data');
        }
      } catch (e) {
        this.log(`Poll error: ${e.message}`, 'warn');
        if (!this.elm.connected) break;
      }
      cycle++;
      const wait = Math.max(150, this.settings.refreshMs - (Date.now() - started));
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  skip(key, cycle) {
    const at = this.unsupported.get(key);
    return at != null && cycle - at < 30; // retry unsupported items every ~30 cycles
  }

  async readByd(p, cycle) {
    const key = `${VEHICLE.bmsHeader}:${p.did}`;
    if (this.skip(key, cycle)) return;
    const r = await this.obd.readDid(VEHICLE.bmsHeader, p.did);
    if (!r) { this.unsupported.set(key, cycle); this.store.mark(p.id, 'nodata'); return; }
    if (r.nrc != null) { this.unsupported.set(key, cycle); this.store.mark(p.id, 'unsupported', { raw: nrcText(r.nrc) }); return; }
    const v = p.decode(r.data);
    const meta = { raw: bytesHex(r.data), source: `UDS 22 ${p.did} @ ${VEHICLE.bmsHeader}` };
    if (v == null || Number.isNaN(v) || v < p.min || v > p.max) this.store.mark(p.id, 'implausible', meta);
    else this.store.set(p.id, v, meta);
  }

  async readCustom(c, cycle) {
    const key = `custom:${c.header}:${c.did}`;
    if (this.skip(key, cycle)) return;
    const r = await this.obd.readDid(c.header, c.did);
    const id = c.target || `custom_${c.header}_${c.did}`;
    if (!r || r.nrc != null) { this.unsupported.set(key, cycle); this.store.mark(id, r ? 'unsupported' : 'nodata'); return; }
    const v = decodeCustom(c, r.data);
    const meta = { raw: bytesHex(r.data), source: `Custom 22 ${c.did} @ ${c.header}` };
    const min = c.min === '' || c.min == null ? -Infinity : Number(c.min);
    const max = c.max === '' || c.max == null ? Infinity : Number(c.max);
    if (v == null || v < min || v > max) this.store.mark(id, 'implausible', meta);
    else this.store.set(id, v, meta);
  }

  async readStd(pid) {
    const r = await this.obd.readPid(pid).catch(() => null);
    if (!r) return;
    this.store.std.set(pid, r);
    const map = { 0x0d: 'speed', 0xa6: 'odometer', 0x46: 'ambient', 0x05: 'coolant', 0x42: 'ecuVoltage', 0x5b: 'evBatteryLife' };
    if (map[pid] && typeof r.value === 'number') this.store.set(map[pid], r.value, { source: `OBD 01 ${hex(pid)}`, raw: bytesHex(r.raw) });
    if (pid === 0x01) this.store.info.mil = !!(r.raw[0] & 0x80);
  }

  async withPause(fn) {
    this.paused = true;
    try { return await fn(); } finally { this.paused = false; }
  }

  async readFaults(onProgress) {
    return this.withPause(async () => {
      const result = { stored: [], pending: [], permanent: [], modules: [] };
      for (const [kind, mode] of [['stored', '03'], ['pending', '07'], ['permanent', '0A']]) {
        onProgress(`Reading ${kind} codes (mode ${mode})…`);
        try { result[kind] = (await this.obd.readDtcs(mode)).map((d) => ({ ...d, kind })); }
        catch (e) { this.log(`Mode ${mode}: ${e.message}`, 'warn'); }
      }
      const mods = [...MODULES, ...this.settings.extraModules.map((h) => ({ header: h, name: `Module ${h}` }))];
      for (const m of mods) {
        onProgress(`Scanning ${m.name} (${m.header})…`);
        try {
          const r = await this.obd.readModuleDtcs(m.header);
          result.modules.push({ ...m, responded: r.responded, codes: r.codes.map((c) => ({ ...c, kind: c.confirmed ? 'stored' : c.pending ? 'pending' : 'history' })) });
        } catch (e) { result.modules.push({ ...m, responded: false, codes: [], error: e.message }); }
      }
      return result;
    });
  }

  async scanDids(header, start, end, onRow, shouldStop) {
    return this.withPause(async () => {
      for (let n = start; n <= end; n++) {
        if (shouldStop()) break;
        const did = hex(n, 4);
        let r = null;
        try { r = await this.obd.readDid(header, did); } catch (e) { r = { error: e.message }; }
        onRow(did, r, n);
      }
    });
  }
}

/* ------------------------------ Demo source ------------------------------ */
export class DemoSource {
  constructor(store, settings, log) {
    this.store = store; this.settings = settings; this.log = log; this.kind = 'demo';
    this.t = 0; this.soc = 72.4;
  }
  async connect(onStatus) {
    onStatus('connected');
    this.store.info.adapter = 'Demo mode (simulated data)';
    this.store.info.vin = 'DEMO0SEALION7PREM';
    this.store.info.supported = [0x01, 0x05, 0x0d, 0x1c, 0x42, 0x46, 0x51, 0xa6];
    this.log('Demo mode started: all values are simulated.');
    this.running = true;
    const tick = () => { if (!this.running) return; this.step(); this.timer = setTimeout(tick, this.settings.refreshMs); };
    tick();
  }
  disconnect() { this.running = false; clearTimeout(this.timer); }
  step() {
    const s = this.store;
    this.t += this.settings.refreshMs / 1000;
    const phase = this.t % 90; // 60 s driving, 30 s DC charging
    const charging = phase > 60;
    const wob = (a, f) => a * Math.sin(this.t * f);
    let speed = 0, current;
    if (charging) { current = -110 + wob(8, 0.5); }
    else { speed = Math.max(0, 62 + wob(38, 0.12) + wob(8, 0.9)); current = speed * 0.9 + wob(40, 0.7) + 8; if (current < -60) current = -60; }
    const voltage = 548 + this.soc * 0.55 - current * 0.04;
    this.soc = Math.min(100, Math.max(5, this.soc - (current * voltage / 1000) * (this.settings.refreshMs / 3.6e6) / VEHICLE.usableKwh * 100 * 10));
    const temp = 31 + wob(3, 0.03) + (charging ? 4 : 0);
    const meta = { source: 'Demo', raw: 'simulated' };
    s.set('soc', this.soc, meta);
    s.set('soh', 97.8, meta);
    s.set('packVoltage', voltage, meta);
    s.set('packCurrent', current, meta);
    s.set('packTemp', temp, meta);
    s.set('moduleHighTemp', temp + 3.2, meta);
    s.set('moduleLowTemp', temp - 2.1, meta);
    s.set('cellMinMv', 3301 + wob(6, 0.2) - current * 0.05, meta);
    s.set('cellMaxMv', 3322 + wob(5, 0.25) - current * 0.05, meta);
    s.set('chargeCount', 214, meta);
    s.set('totalChargedKwh', 6233, meta);
    s.set('totalDischargedKwh', 5975, meta);
    s.set('aux12v', charging ? 13.9 : 14.1 + wob(0.08, 1.3), meta);
    s.set('ecuVoltage', 14.05, meta);
    s.set('speed', speed, meta);
    s.set('odometer', 18342.6 + this.t * 0.01, meta);
    s.set('ambient', 24, meta);
    s.set('coolant', 34 + wob(2, 0.05), meta);
    s.info.charging = charging;
    s.info.mil = false;
    const std = [[0x01, 'MIL off, 1 DTC'], [0x05, Math.round(s.values.coolant)], [0x0d, Math.round(speed)], [0x1c, 'EOBD (Europe)'],
      [0x42, 14.05], [0x46, 24], [0x51, 'Electric'], [0xa6, s.values.odometer.toFixed(1)]];
    std.forEach(([pid, value]) => s.std.set(pid, { ecu: '7E8', value, raw: [] }));
    s.derive(this.settings);
    s.emit('data');
  }
  async readFaults(onProgress) {
    onProgress('Reading fault codes (demo)…');
    await new Promise((r) => setTimeout(r, 900));
    return {
      stored: [],
      pending: [{ code: 'C0040', ecu: '7E8', kind: 'pending' }],
      permanent: [],
      modules: MODULES.map((m) => ({ ...m, responded: true, codes: m.header === '7E7'
        ? [{ code: 'P0A9B', ftb: '16', status: 0x2c, ecu: '7EF', confirmed: true, kind: 'stored' }] : [] })),
    };
  }
  async scanDids(header, start, end, onRow, shouldStop) {
    for (let n = start; n <= end; n++) {
      if (shouldStop()) break;
      await new Promise((r) => setTimeout(r, 15));
      const ok = n % 7 === 0;
      onRow(hex(n, 4), ok ? { ecu: '7EF', data: [n & 0xff, (n * 3) & 0xff] } : { nrc: 0x31 }, n);
    }
  }
}

export { stdPidInfo };
