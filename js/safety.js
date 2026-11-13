/*
 * READ-ONLY SAFETY GUARD
 * ----------------------
 * Every command sent to the OBD2 adapter goes through assertReadOnly() at the
 * lowest transport level. Only an explicit allow-list of read commands can
 * reach the adapter; anything else throws before a single byte is written.
 *
 * Allowed:
 *   - ELM327 adapter configuration (AT...) that only affects the adapter itself
 *   - OBD2 Mode 01  (read current data)
 *   - OBD2 Mode 03 / 07 / 0A (read stored / pending / permanent fault codes)
 *   - OBD2 Mode 09  (read vehicle information, e.g. VIN)
 *   - UDS 0x22      (ReadDataByIdentifier)
 *   - UDS 0x19 01/02 (ReadDTCInformation)
 *
 * Never allowed (blocked because they are not on the list), for example:
 *   - Mode 04 / UDS 0x14  clear fault codes
 *   - UDS 0x2E  WriteDataByIdentifier      - UDS 0x2F  IO control
 *   - UDS 0x31  RoutineControl              - UDS 0x10  session change
 *   - UDS 0x11  ECU reset                   - UDS 0x27  security access
 *   - UDS 0x28 / 0x85 / 0x34-0x37  comms control, DTC setting, flashing
 *   - ELM327 commands that transmit arbitrary frames (ATMA, ATBD, ATPP, ...)
 */

const ALLOWED = Object.freeze([
  // --- ELM327 adapter-only configuration ---
  /^ATZ$/, /^ATWS$/, /^ATD0?$/, /^ATI$/, /^AT@1$/, /^ATRV$/, /^ATDPN?$/,
  /^ATE[01]$/, /^ATL[01]$/, /^ATS[01]$/, /^ATH[01]$/, /^ATM0$/, /^ATAL$/,
  /^ATSP[0-9A-C]$/, /^ATAT[0-2]$/, /^ATST[0-9A-F]{2}$/, /^ATCAF[01]$/, /^ATAR$/,
  /^ATSH[0-9A-F]{3}$/, /^ATSH[0-9A-F]{6}$/, /^ATCRA([0-9A-F]{3})?$/,
  /^ATFCSH[0-9A-F]{3}$/, /^ATFCSD[0-9A-F]{2,10}$/, /^ATFCSM[01]$/,
  // --- OBD2 read services ---
  /^01[0-9A-F]{2}[1-9]?$/,
  /^03$/, /^07$/, /^0A$/,
  /^09[0-9A-F]{2}$/,
  // --- UDS read services ---
  /^22[0-9A-F]{4}[1-9]?$/,
  /^19(01|02)[0-9A-F]{2}$/,
]);

export class ReadOnlyViolation extends Error {
  constructor(cmd) {
    super(`Blocked by read-only guard: "${cmd}" is not an approved read command.`);
    this.name = 'ReadOnlyViolation';
  }
}

export function normalise(cmd) {
  return String(cmd).toUpperCase().replace(/\s+/g, '');
}

export function isReadOnly(cmd) {
  const c = normalise(cmd);
  if (!/^[0-9A-Z@]+$/.test(c)) return false; // no CR/LF injection, no odd chars
  return ALLOWED.some((re) => re.test(c));
}

export function assertReadOnly(cmd) {
  if (!isReadOnly(cmd)) throw new ReadOnlyViolation(cmd);
  return normalise(cmd);
}
