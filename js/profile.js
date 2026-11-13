/*
 * BYD Sealion 7 Premium profile.
 *
 * BYD exposes battery data through manufacturer-specific UDS 0x22 identifiers on
 * the battery management system (request 7E7 / reply 7EF). The identifiers below
 * come from community work on the BYD Atto 3 / Dolphin (same e-Platform 3.0) and
 * Sealion 7 owner reports. Each carries a confidence note; values outside the
 * plausible range are rejected instead of shown, so a wrong formula can never
 * show a misleading number.
 *
 * Byte naming: d[0] is the first data byte after the "62 XX XX" echo
 * (called B4 in the community lists, where B0 is the ISO-TP length byte).
 */

export const VEHICLE = {
  name: 'BYD Sealion 7 Premium',
  usableKwh: 82.5,
  bmsHeader: '7E7',
};

const le16 = (d, o = 0) => d[o] | (d[o + 1] << 8);

export const BYD_PIDS = [
  { id: 'soc', did: '1FFC', name: 'State of charge (BMS)', unit: '%', min: 0, max: 100, dp: 1,
    decode: (d) => le16(d) / 100, confidence: 'Confirmed on Atto 3 / Dolphin' },
  { id: 'packTemp', did: '0032', name: 'Battery pack temperature', unit: '°C', min: -40, max: 90, dp: 0,
    decode: (d) => d[0] - 40, confidence: 'Confirmed on Atto 3 / Dolphin' },
  { id: 'packVoltage', did: '0008', name: 'Battery pack voltage', unit: 'V', min: 200, max: 1000, dp: 0,
    decode: (d) => le16(d), confidence: 'Sealion 7 owner reported ≈560 V; verify' },
  { id: 'packCurrent', did: '0009', name: 'Battery pack current', unit: 'A', min: -600, max: 1000, dp: 1,
    decode: (d) => (le16(d) - 5000) / 10, confidence: 'Reported working on Dolphin' },
  { id: 'chargeCount', did: '000B', name: 'Charge sessions', unit: '', min: 0, max: 100000, dp: 0,
    decode: (d) => le16(d), confidence: 'Confirmed on Atto 3 / Dolphin', slow: true },
  { id: 'totalChargedKwh', did: '0011', name: 'Lifetime energy charged', unit: 'kWh', min: 0, max: 1e6, dp: 0,
    decode: (d) => le16(d), confidence: 'Confirmed on Atto 3 / Dolphin', slow: true },
  { id: 'totalDischargedKwh', did: '0012', name: 'Lifetime energy used', unit: 'kWh', min: 0, max: 1e6, dp: 0,
    decode: (d) => le16(d), confidence: 'Confirmed on Atto 3 / Dolphin', slow: true },
  { id: 'cellMinMv', did: '016D', name: 'Lowest cell voltage (module 1)', unit: 'mV', min: 2000, max: 4500, dp: 0,
    decode: (d) => le16(d), confidence: 'Unverified - investigate with Tools', slow: true },
  { id: 'moduleHighTemp', did: '0171', name: 'Highest module temperature', unit: '°C', min: -40, max: 90, dp: 0,
    decode: (d) => d[0] - 40, confidence: 'Unverified - investigate with Tools', slow: true },
  { id: 'moduleLowTemp', did: '0173', name: 'Lowest module temperature', unit: '°C', min: -40, max: 90, dp: 0,
    decode: (d) => d[0] - 40, confidence: 'Unverified - investigate with Tools', slow: true },
];

/* Values the dashboard can show, with user-facing labels and thresholds.
 * status(v) returns 'good' | 'warn' | 'bad' | 'none'. */
const band = (v, goodLo, goodHi, warnLo, warnHi) =>
  v >= goodLo && v <= goodHi ? 'good' : v >= warnLo && v <= warnHi ? 'warn' : 'bad';

export const METRICS = {
  soc: { label: 'State of charge', unit: '%', dp: 0, status: (v) => (v >= 30 ? 'good' : v >= 15 ? 'warn' : 'bad'),
    help: 'Green ≥ 30 %, amber 15-29 %, red < 15 %' },
  soh: { label: 'State of health', unit: '%', dp: 1, status: (v) => (v >= 90 ? 'good' : v >= 80 ? 'warn' : 'bad'),
    help: 'Green ≥ 90 %, amber 80-89 %, red < 80 %' },
  packTemp: { label: 'Pack temperature', unit: '°C', dp: 0, status: (v) => band(v, 15, 35, 0, 45),
    help: 'Green 15-35 °C, amber 0-14 / 36-45 °C, red outside' },
  moduleHighTemp: { label: 'Hottest module', unit: '°C', dp: 0, status: (v) => band(v, 15, 38, 0, 48),
    help: 'Green 15-38 °C, amber 0-14 / 39-48 °C, red outside' },
  moduleLowTemp: { label: 'Coolest module', unit: '°C', dp: 0, status: (v) => band(v, 12, 35, 0, 45),
    help: 'Green 12-35 °C, amber 0-11 / 36-45 °C, red outside' },
  tempSpread: { label: 'Temp spread', unit: '°C', dp: 0, status: (v) => (v <= 5 ? 'good' : v <= 10 ? 'warn' : 'bad'),
    help: 'Green ≤ 5 °C, amber 6-10 °C, red > 10 °C' },
  packVoltage: { label: 'Pack voltage', unit: 'V', dp: 0, status: () => 'none' },
  packCurrent: { label: 'Pack current', unit: 'A', dp: 1, status: () => 'none' },
  power: { label: 'Battery power', unit: 'kW', dp: 1, status: (v) => (Math.abs(v) <= 150 ? 'good' : Math.abs(v) <= 220 ? 'warn' : 'bad'),
    help: 'Positive = discharging (driving), negative = charging / regen' },
  cellMinMv: { label: 'Lowest cell', unit: 'mV', dp: 0, status: (v) => band(v, 3000, 3650, 2800, 3700),
    help: 'LFP Blade cells: green 3000-3650 mV' },
  cellMaxMv: { label: 'Highest cell', unit: 'mV', dp: 0, status: (v) => band(v, 3000, 3650, 2800, 3700) },
  cellDeltaMv: { label: 'Cell imbalance', unit: 'mV', dp: 0, status: (v) => (v <= 30 ? 'good' : v <= 80 ? 'warn' : 'bad'),
    help: 'Difference between highest and lowest cell. Green ≤ 30 mV, amber ≤ 80 mV, red > 80 mV' },
  aux12v: { label: '12 V battery', unit: 'V', dp: 2, status: (v) => band(v, 12.3, 14.8, 11.9, 15.2),
    help: 'Read at the OBD port. Green 12.3-14.8 V, amber 11.9-12.2 V, red below' },
  ecuVoltage: { label: 'Control module voltage', unit: 'V', dp: 2, status: (v) => band(v, 12.3, 14.8, 11.9, 15.2) },
  chargeCount: { label: 'Charge sessions', unit: '', dp: 0, status: () => 'none' },
  totalChargedKwh: { label: 'Lifetime charged', unit: 'kWh', dp: 0, status: () => 'none' },
  totalDischargedKwh: { label: 'Lifetime used', unit: 'kWh', dp: 0, status: () => 'none' },
  fullCycles: { label: 'Equivalent full cycles', unit: '', dp: 1, status: (v) => (v < 1500 ? 'good' : v < 3000 ? 'warn' : 'bad'),
    help: 'Lifetime used ÷ usable capacity. Blade LFP cells are rated for 3000+ cycles' },
  rangeEst: { label: 'Estimated range', unit: 'km', dp: 0, status: (v) => (v >= 120 ? 'good' : v >= 50 ? 'warn' : 'bad'),
    help: 'SOC × usable capacity ÷ your consumption setting' },
  speed: { label: 'Speed', unit: 'km/h', dp: 0, status: () => 'none' },
  odometer: { label: 'Odometer', unit: 'km', dp: 0, status: () => 'none' },
  ambient: { label: 'Outside temperature', unit: '°C', dp: 0, status: () => 'none' },
  coolant: { label: 'Coolant temperature', unit: '°C', dp: 0, status: (v) => (v <= 60 ? 'good' : v <= 75 ? 'warn' : 'bad') },
  evBatteryLife: { label: 'EV battery remaining life (std PID)', unit: '%', dp: 0, status: () => 'none' },
};

export function statusOf(id, v) {
  const m = METRICS[id];
  if (!m || v == null || Number.isNaN(v)) return 'none';
  return m.status(v);
}

/* --------------------------- Fault descriptions --------------------------- */
export const DTC_TEXT = {
  P0562: 'System voltage low', P0563: 'System voltage high',
  P0A09: 'DC/DC converter status circuit low', P0A0A: 'High-voltage system interlock circuit',
  P0A0D: 'High-voltage system interlock circuit high', P0A1F: 'Battery energy control module performance',
  P0A2F: 'Drive motor A over temperature', P0A3C: 'Drive motor A inverter over temperature',
  P0A7D: 'Hybrid/EV battery pack state of charge low', P0A7E: 'Hybrid/EV battery pack over temperature',
  P0A7F: 'Hybrid/EV battery pack deterioration', P0A80: 'Replace hybrid/EV battery pack',
  P0A8D: '14 V power module system voltage low', P0A94: 'DC/DC converter performance',
  P0A9B: 'Hybrid/EV battery temperature sensor A circuit', P0AA0: 'Hybrid/EV battery positive contactor circuit',
  P0AA1: 'Hybrid/EV battery positive contactor stuck closed', P0AA4: 'Hybrid/EV battery negative contactor stuck closed',
  P0AA6: 'Hybrid/EV battery voltage system isolation fault', P0AC0: 'Hybrid/EV battery pack current sensor circuit',
  P0AC4: 'Hybrid powertrain control module requested MIL', P0AFA: 'Hybrid/EV battery system voltage low',
  C0035: 'Left front wheel speed sensor circuit', C0040: 'Right front wheel speed sensor circuit',
  C0045: 'Left rear wheel speed sensor circuit', C0050: 'Right rear wheel speed sensor circuit',
  U0100: 'Lost communication with ECM/PCM', U0111: 'Lost communication with battery energy control module A',
  U0140: 'Lost communication with body control module', U0293: 'Lost communication with hybrid powertrain control module',
  U0298: 'Lost communication with DC/DC converter control module',
};

export function describeDtc(code) {
  if (DTC_TEXT[code]) return DTC_TEXT[code];
  const sys = { P: 'Powertrain', C: 'Chassis', B: 'Body', U: 'Network / communication' }[code[0]];
  const generic = code[1] === '0' || (code[0] === 'P' && code[1] === '2');
  if (code[0] === 'P' && /^P0[ABC]/.test(code)) return 'Hybrid/EV propulsion system fault (generic code)';
  return `${sys} - ${generic ? 'generic SAE code' : 'BYD-specific code (see dealer documentation)'}`;
}

/** HV battery / propulsion and network codes are treated as critical. */
export function dtcSeverity(dtc) {
  const hv = /^P0[ABCD]/.test(dtc.code) || /^U0(111|293|298)/.test(dtc.code);
  if (dtc.kind === 'pending' && !hv) return 'warn';
  return hv || dtc.kind === 'permanent' || dtc.mil ? 'bad' : dtc.kind === 'pending' ? 'warn' : 'bad';
}

/* Default physical addresses scanned for module fault codes (UDS 19 02 FF). */
export const MODULES = [
  { header: '7E0', name: 'Powertrain / vehicle controller' },
  { header: '7E1', name: 'Motor controller' },
  { header: '7E2', name: 'Module 7E2' },
  { header: '7E3', name: 'Module 7E3' },
  { header: '7E4', name: 'Module 7E4' },
  { header: '7E5', name: 'Module 7E5' },
  { header: '7E6', name: 'Module 7E6' },
  { header: '7E7', name: 'Battery management (BMS)' },
];
