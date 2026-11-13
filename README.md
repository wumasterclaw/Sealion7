# Sealion 7 Dashboard

A **read-only** OBD2 dashboard web app for the **BYD Sealion 7 Premium**. It runs in Chrome on Android
and talks to a Bluetooth LE OBD2 adapter. No app store or server is needed, and it installs to the home screen.

## What it shows

| Section | Contents |
|---|---|
| **Overview** | Animated SOC gauge, estimated range, pack temperature, battery power, 12 V battery, health tiles, power-flow bar, speed / odometer / outside temp |
| **Battery** | SOC, SOH and pack-temperature gauges, a thermal band (pack + module min/max), cell voltages and imbalance, lifetime energy and cycles, 10-minute trend charts |
| **Faults** | Stored, pending and permanent OBD2 codes plus a per-module UDS scan, with descriptions. **View only: codes are never cleared.** |
| **All data** | Every standard PID the car reports as supported, every BYD battery value with raw bytes, VIN and adapter |
| **Tools** | Settings, custom PIDs, an identifier discovery scanner, a live console and CSV export |

Every value is colour-coded with an icon and a label: **green = Good**, **amber = Warning**, **red = Fault**.
Hover over (or long-press) a tile to see the thresholds.

## Read-only guarantee

`js/safety.js` holds an allow-list that **every** command passes through at the lowest transport level.
Only adapter set-up (`AT…`), OBD2 modes `01`, `03`, `07`, `0A`, `09`, and UDS `0x22` / `0x19 01|02` can be sent.
Clearing codes (`04`, `0x14`), writes (`0x2E`), routines (`0x31`), session changes (`0x10`), resets (`0x11`),
security access, flashing and raw frame transmission are all blocked before a byte reaches the adapter.

## Hardware

You need a **Bluetooth LE (BLE)** ELM327-compatible adapter. Classic Bluetooth adapters can't be reached from a browser.
Known-good choices for BYD e-Platform 3.0 include **vLinker MC+ / FS BLE**, **Vgate iCar Pro BLE 4.0**,
**OBDLink CX** and **Veepeak OBDCheck BLE+**.

## Using it

1. Host the folder over HTTPS. **GitHub Pages** is easiest: Settings → Pages → Deploy from branch → `main` / root.
2. Open the page in **Chrome on Android**, then use ⋮ → *Add to Home screen*.
3. Plug in the adapter and put the car in **Ready** mode (or at least accessory power on).
4. Tap **Connect OBD2 adapter** and pick the adapter from the list.

Add `?demo` to the URL, or tap **Try demo mode**, to see the dashboard with simulated data.

## About the BYD battery data

BYD keeps battery data behind manufacturer-specific UDS identifiers on the BMS (`7E7` → `7EF`).
The profile in `js/profile.js` uses identifiers that the community confirmed on the Atto 3 and Dolphin (same platform),
plus Sealion 7 owner reports. Each one is labelled with its confidence. If a value decodes outside a plausible range,
the app shows "check formula" instead of a wrong number.

**State of health has no publicly confirmed identifier yet.** Use *Tools → Identifier discovery scan* on `7E7` to find it
(compare against the SOH shown in the BYD app or service report), then add it under *Custom PIDs* with "Show as: State of health".

Sources: [BYD-PID-list](https://github.com/loryanstrant/BYD-PID-list),
[OVMS BYD Atto 3](https://docs.openvehicles.com/en/latest/components/vehicle_byd_atto3/docs/index.html),
[ABRP Sealion 7 thread](https://abrp.featurebase.app/p/byd-sealion-7-22).

## Safety

Only look at the dashboard while parked, or let a passenger read it.

## Files

```
index.html            page layout (5 sections)
css/styles.css        theme, gauges, animations, responsive layout
js/safety.js          read-only allow-list (the guard)
js/elm.js             Web Bluetooth ELM327 transport
js/obd.js             ISO-TP parsing, standard PIDs, DTC decoding, UDS reads
js/profile.js         Sealion 7 profile: BYD identifiers, thresholds, fault descriptions
js/sources.js         live polling, demo simulator, data store
js/app.js             UI: gauges, tiles, charts, faults, tools
sw.js, manifest       offline + install to home screen
```
