/*
 * OBD2 / UDS protocol layer on top of an ELM327 transport.
 * Responses are requested with headers on (ATH1, ATS1) so replies from several
 * ECUs can be separated and ISO-TP multi-frame messages reassembled.
 */

export const hex = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');
const u16 = (a, b) => (a << 8) | b;

const ERRORS = /^(NO DATA|CAN ERROR|BUS ERROR|BUFFER FULL|STOPPED|UNABLE TO CONNECT|\?|ERROR|FB ERROR|DATA ERROR|ACT ALERT|LV RESET|LP ALERT)/i;

/** Parse ELM lines (headers on) into Map<header, Uint8 payload[]>. */
export function parseFrames(lines) {
  const out = new Map();
  const state = new Map();
  const errors = [];
  for (const line of lines) {
    if (ERRORS.test(line)) { errors.push(line); continue; }
    const t = line.split(/\s+/).filter(Boolean);
    if (!t.every((x) => /^[0-9A-F]+$/i.test(x))) continue;
    let header, bytes;
    if (t[0].length === 3) { header = t[0].toUpperCase(); bytes = t.slice(1); }
    else if (t.length > 4 && t.slice(0, 4).every((x) => x.length === 2) && t[0] === '18') {
      header = t.slice(0, 4).join('').toUpperCase(); bytes = t.slice(4);
    } else { header = '???'; bytes = t; }
    bytes = bytes.map((b) => parseInt(b, 16));
    if (!bytes.length) continue;
    const pci = bytes[0] >> 4;
    if (pci === 0) {
      out.set(header, bytes.slice(1, 1 + (bytes[0] & 0x0f)));
    } else if (pci === 1) {
      const len = ((bytes[0] & 0x0f) << 8) | bytes[1];
      state.set(header, { len, data: bytes.slice(2) });
    } else if (pci === 2) {
      const s = state.get(header);
      if (s) {
        s.data.push(...bytes.slice(1));
        if (s.data.length >= s.len) { out.set(header, s.data.slice(0, s.len)); state.delete(header); }
      }
    }
  }
  for (const [h, s] of state) out.set(h, s.data.slice(0, s.len)); // incomplete, best effort
  return { frames: out, errors };
}

const NRC = {
  0x11: 'Service not supported', 0x12: 'Sub-function not supported', 0x13: 'Bad length',
  0x22: 'Conditions not correct', 0x31: 'Request out of range (not supported)',
  0x33: 'Security access denied', 0x7e: 'Not supported in current session',
  0x7f: 'Service not supported in current session', 0x78: 'Response pending',
};
export const nrcText = (code) => NRC[code] || `Negative response 0x${hex(code)}`;

/* ---------------------------- Standard PIDs ---------------------------- */
// d = data bytes after "41 PID" (A, B, C, D ...)
const STD = {
  0x01: { name: 'Monitor status (MIL & DTC count)', unit: '', f: (d) => `MIL ${d[0] & 0x80 ? 'ON' : 'off'}, ${d[0] & 0x7f} DTC` },
  0x04: { name: 'Calculated load', unit: '%', f: (d) => d[0] * 100 / 255 },
  0x05: { name: 'Coolant temperature', unit: '°C', f: (d) => d[0] - 40 },
  0x0b: { name: 'Intake manifold pressure', unit: 'kPa', f: (d) => d[0] },
  0x0c: { name: 'Motor / engine speed', unit: 'rpm', f: (d) => u16(d[0], d[1]) / 4 },
  0x0d: { name: 'Vehicle speed', unit: 'km/h', f: (d) => d[0] },
  0x0f: { name: 'Intake air temperature', unit: '°C', f: (d) => d[0] - 40 },
  0x11: { name: 'Throttle / accelerator position', unit: '%', f: (d) => d[0] * 100 / 255 },
  0x1c: { name: 'OBD standard', unit: '', f: (d) => ({ 1: 'OBD-II (CARB)', 2: 'OBD (EPA)', 3: 'OBD + OBD-II', 6: 'EOBD (Europe)', 7: 'EOBD + OBD-II', 9: 'EOBD + OBD + OBD-II', 0x0d: 'JOBD + EOBD', 0x11: 'Engine Manufacturer Diagnostics' }[d[0]] || `Type ${d[0]}`) },
  0x1f: { name: 'Run time since start', unit: 's', f: (d) => u16(d[0], d[1]) },
  0x21: { name: 'Distance with MIL on', unit: 'km', f: (d) => u16(d[0], d[1]) },
  0x2f: { name: 'Fuel / energy level input', unit: '%', f: (d) => d[0] * 100 / 255 },
  0x30: { name: 'Warm-ups since codes cleared', unit: '', f: (d) => d[0] },
  0x31: { name: 'Distance since codes cleared', unit: 'km', f: (d) => u16(d[0], d[1]) },
  0x33: { name: 'Barometric pressure', unit: 'kPa', f: (d) => d[0] },
  0x42: { name: 'Control module voltage', unit: 'V', f: (d) => u16(d[0], d[1]) / 1000 },
  0x43: { name: 'Absolute load', unit: '%', f: (d) => u16(d[0], d[1]) * 100 / 255 },
  0x45: { name: 'Relative throttle position', unit: '%', f: (d) => d[0] * 100 / 255 },
  0x46: { name: 'Ambient air temperature', unit: '°C', f: (d) => d[0] - 40 },
  0x49: { name: 'Accelerator pedal position D', unit: '%', f: (d) => d[0] * 100 / 255 },
  0x4a: { name: 'Accelerator pedal position E', unit: '%', f: (d) => d[0] * 100 / 255 },
  0x4d: { name: 'Time run with MIL on', unit: 'min', f: (d) => u16(d[0], d[1]) },
  0x4e: { name: 'Time since codes cleared', unit: 'min', f: (d) => u16(d[0], d[1]) },
  0x51: { name: 'Fuel type', unit: '', f: (d) => ({ 8: 'Electric', 0x11: 'Hybrid electric', 0x0f: 'Battery electric', 1: 'Petrol', 4: 'Diesel' }[d[0]] || `Type ${d[0]}`) },
  0x5b: { name: 'Hybrid/EV battery pack remaining life', unit: '%', f: (d) => d[0] * 100 / 255 },
  0x5c: { name: 'Oil temperature', unit: '°C', f: (d) => d[0] - 40 },
  0x62: { name: 'Actual torque', unit: '%', f: (d) => d[0] - 125 },
  0x63: { name: 'Reference torque', unit: 'Nm', f: (d) => u16(d[0], d[1]) },
  0x8e: { name: 'Friction torque', unit: '%', f: (d) => d[0] - 125 },
  0xa4: { name: 'Transmission actual gear', unit: '', f: (d) => (d[1] ? u16(d[1], d[2] || 0) / 1000 : '—') },
  0xa6: { name: 'Odometer', unit: 'km', f: (d) => ((d[0] << 24) >>> 0 | (d[1] << 16) | (d[2] << 8) | d[3]) / 10 },
};
export const stdPidInfo = (pid) => STD[pid] || { name: `PID 0x${hex(pid)}`, unit: '', f: (d) => d.map((b) => hex(b)).join(' ') };

/* ----------------------------- Fault codes ----------------------------- */
export function decodeDtc(a, b) {
  const sys = 'PCBU'[a >> 6];
  return `${sys}${(a >> 4) & 0x3}${hex(a & 0x0f, 1)}${hex(b)}`;
}

/* ------------------------------- Client -------------------------------- */
export class ObdClient {
  constructor(elm, log = () => {}) {
    this.elm = elm;
    this.log = log;
    this.header = null;
  }

  async init() {
    const r = await this.elm.send('ATZ', 6000).catch(() => []);
    const steps = ['ATE0', 'ATL0', 'ATS1', 'ATH1', 'ATAT1', 'ATSP6', 'ATST96'];
    for (const s of steps) await this.elm.send(s).catch((e) => this.log(`${s}: ${e.message}`, 'warn'));
    const id = await this.elm.send('ATI').catch(() => r);
    this.adapterId = (id || []).join(' ') || 'ELM327';
    await this.setHeader('7DF');
    return this.adapterId;
  }

  /** Physical headers (7E0..7E7 etc.) use flow-control settings proven on BYD e-Platform 3.0. */
  async setHeader(h) {
    if (this.header === h) return;
    await this.elm.send(`ATSH${h}`);
    if (h === '7DF') {
      await this.elm.send('ATFCSM0');
      await this.elm.send('ATCRA');
    } else {
      await this.elm.send(`ATFCSH${h}`);
      await this.elm.send('ATFCSD300000');
      await this.elm.send('ATFCSM1');
    }
    this.header = h;
  }

  /** Header change + command run as one atomic step so concurrent callers never interleave. */
  request(header, cmd, timeout) {
    const run = async () => {
      await this.setHeader(header);
      return parseFrames(await this.elm.send(cmd, timeout));
    };
    const p = (this.lock || Promise.resolve()).then(run, run);
    this.lock = p.catch(() => {});
    return p;
  }

  async batteryVoltage() {
    const r = await this.elm.send('ATRV');
    const m = (r[0] || '').match(/([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  }

  /** All Mode 01 PIDs any ECU reports as supported. */
  async supportedPids() {
    const set = new Set();
    for (let base = 0; base <= 0xe0; base += 0x20) {
      const { frames } = await this.request('7DF', `01${hex(base)}`);
      let more = false;
      for (const p of frames.values()) {
        if (p[0] !== 0x41 || p[1] !== base) continue;
        const bits = p.slice(2, 6);
        bits.forEach((byte, i) => {
          for (let b = 0; b < 8; b++) if (byte & (0x80 >> b)) set.add(base + i * 8 + b + 1);
        });
        if (bits[3] & 1) more = true;
      }
      if (!more) break;
    }
    return [...set].filter((p) => p % 0x20 !== 0).sort((a, b) => a - b);
  }

  async readPid(pid) {
    const { frames } = await this.request('7DF', `01${hex(pid)}`);
    for (const [h, p] of frames) {
      if (p[0] === 0x41 && p[1] === pid) {
        const info = stdPidInfo(pid);
        return { ecu: h, raw: p.slice(2), value: info.f(p.slice(2)) };
      }
    }
    return null;
  }

  async vin() {
    const { frames } = await this.request('7DF', '0902', 6000);
    for (const p of frames.values()) {
      if (p[0] === 0x49 && p[1] === 0x02) {
        return String.fromCharCode(...p.slice(3).filter((c) => c >= 0x20 && c < 0x7f)).trim();
      }
    }
    return null;
  }

  /** Mode 03 (stored), 07 (pending), 0A (permanent). */
  async readDtcs(mode) {
    const { frames } = await this.request('7DF', mode, 6000);
    const want = parseInt(mode, 16) + 0x40;
    const codes = [];
    for (const [ecu, p] of frames) {
      if (p[0] !== want) continue;
      for (let i = 2; i + 1 < p.length; i += 2) {
        if (p[i] === 0 && p[i + 1] === 0) continue;
        codes.push({ code: decodeDtc(p[i], p[i + 1]), ecu });
      }
    }
    return codes;
  }

  /** UDS 19 02 FF on one module (physical address). */
  async readModuleDtcs(header) {
    const { frames, errors } = await this.request(header, '1902FF', 6000);
    const codes = [];
    let responded = errors.length === 0 && frames.size > 0;
    for (const [ecu, p] of frames) {
      if (p[0] === 0x7f) { responded = true; continue; }
      if (p[0] !== 0x59) continue;
      // payload: 59 02 <availabilityMask> then 4-byte records [DTC hi, DTC mid, failure type, status]
      for (let i = 3; i + 3 < p.length; i += 4) {
        const status = p[i + 3];
        if (!status) continue;
        codes.push({
          code: decodeDtc(p[i], p[i + 1]), ftb: hex(p[i + 2]), status, ecu,
          confirmed: !!(status & 0x08), pending: !!(status & 0x04),
          active: !!(status & 0x01), mil: !!(status & 0x80),
        });
      }
    }
    return { responded, codes };
  }

  /** UDS 0x22 ReadDataByIdentifier. Returns {data} or {nrc} or null. */
  async readDid(header, did) {
    const { frames } = await this.request(header, `22${did}`);
    const hi = parseInt(did.slice(0, 2), 16);
    const lo = parseInt(did.slice(2, 4), 16);
    for (const [ecu, p] of frames) {
      if (p[0] === 0x62 && p[1] === hi && p[2] === lo) return { ecu, data: p.slice(3) };
      if (p[0] === 0x7f && p[1] === 0x22) return { ecu, nrc: p[2] };
    }
    return null;
  }
}
