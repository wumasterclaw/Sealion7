/*
 * ELM327 over Bluetooth Low Energy (Web Bluetooth).
 * Works with BLE adapters (Vgate iCar Pro BLE, vLinker, OBDLink CX, Veepeak BLE+ ...).
 * Classic-Bluetooth (SPP) adapters cannot be used from a browser.
 */
import { assertReadOnly } from './safety.js';

// Service UUIDs used by common BLE OBD2 adapters. Characteristics are detected
// automatically by their properties (notify + write), so clones also work.
export const BLE_SERVICES = [
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '000018f0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '0000beef-0000-1000-8000-00805f9b34fb',
];

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ElmBle {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.queue = Promise.resolve();
    this.buffer = '';
    this.pending = null;
    this.onDisconnect = null;
  }

  static supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get connected() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected);
  }

  get name() {
    return this.device ? this.device.name || 'OBD2 adapter' : '';
  }

  async connect() {
    if (!ElmBle.supported()) {
      throw new Error('Web Bluetooth is not available. Use Chrome on Android, opened over HTTPS.');
    }
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: BLE_SERVICES,
    });
    this.device.addEventListener('gattserverdisconnected', () => {
      this.log('Adapter disconnected', 'warn');
      if (this.pending) this.pending.reject(new Error('Disconnected'));
      this.onDisconnect && this.onDisconnect();
    });
    this.log(`Connecting to ${this.name}…`);
    const server = await this.device.gatt.connect();

    let found = null;
    for (const uuid of BLE_SERVICES) {
      let svc;
      try { svc = await server.getPrimaryService(uuid); } catch { continue; }
      const chars = await svc.getCharacteristics();
      const rx = chars.find((c) => c.properties.notify || c.properties.indicate);
      const tx = chars.find((c) => c.properties.writeWithoutResponse || c.properties.write);
      if (rx && tx) { found = { rx, tx, uuid }; break; }
    }
    if (!found) {
      this.device.gatt.disconnect();
      throw new Error('No compatible OBD2 serial service found on this device. Is it a BLE ELM327 adapter?');
    }
    this.rx = found.rx;
    this.tx = found.tx;
    this.log(`Using BLE service ${found.uuid}`);
    await this.rx.startNotifications();
    this.rx.addEventListener('characteristicvaluechanged', (e) => this._onData(e.target.value));
  }

  disconnect() {
    try { this.device && this.device.gatt.connected && this.device.gatt.disconnect(); } catch { /* ignore */ }
  }

  _onData(dataView) {
    this.buffer += dec.decode(dataView);
    if (this.buffer.includes('>') && this.pending) {
      const raw = this.buffer;
      this.buffer = '';
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(raw);
    }
  }

  async _write(text) {
    const bytes = enc.encode(text + '\r');
    const useNoResp = this.tx.properties.writeWithoutResponse;
    for (let i = 0; i < bytes.length; i += 20) {
      const chunk = bytes.slice(i, i + 20);
      if (useNoResp) await this.tx.writeValueWithoutResponse(chunk);
      else await this.tx.writeValue(chunk);
    }
  }

  /**
   * Send one command and resolve with cleaned response lines.
   * The read-only guard runs here, so nothing unapproved can ever be written.
   */
  send(cmd, timeout = 4000) {
    const safe = assertReadOnly(cmd); // throws on anything not read-only
    const run = () => new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Not connected'));
      this.buffer = '';
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`Timeout waiting for "${safe}"`));
      }, timeout);
      this.pending = {
        timer,
        reject: (e) => { clearTimeout(timer); reject(e); },
        resolve: (raw) => {
          const lines = raw.replace(/>/g, '').split(/[\r\n]+/)
            .map((l) => l.trim())
            .filter((l) => l && l !== safe && !/^SEARCHING/i.test(l) && !/^BUS INIT/i.test(l));
          this.log(`${safe} → ${lines.join(' | ') || '(empty)'}`, 'io');
          resolve(lines);
        },
      };
      this._write(safe).catch((e) => { this.pending = null; clearTimeout(timer); reject(e); });
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}
