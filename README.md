<p align="center">
  <a href="https://witekin.github.io/winterdash/"><img src=".github/winterdash-header.png" alt="WinterDash" width="400"></a>
</p>

<p align="center">
  <a href="https://github.com/witekin/winterdash-ha/releases"><img src="https://img.shields.io/github/v/release/witekin/winterdash-ha?color=38bdf8&label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/witekin/winterdash-ha?color=2f855a" alt="License: GPL-3.0"></a>
  <a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=witekin&repository=winterdash-ha&category=integration"><img src="https://img.shields.io/badge/HACS-Custom-41BDF5?logo=homeassistant&logoColor=fff" alt="HACS custom repository"></a>
</p>

<p align="center"><em>Your WinterDash charge dashboard — the vehicle and its status, mirrored into Home Assistant.</em></p>

---

<p align="center">
  <a href="https://witekin.github.io/winterdash/"><img src="https://img.shields.io/badge/Website-30363d?style=for-the-badge" alt="Website"></a>
  <a href="https://witekin.github.io/winterdash/flash/"><img src="https://img.shields.io/badge/Flash_a_board-38bdf8?style=for-the-badge&labelColor=38bdf8" alt="Flash a board"></a>
  <a href="https://github.com/witekin/winterdash/wiki"><img src="https://img.shields.io/badge/Wiki-30363d?style=for-the-badge" alt="Wiki"></a>
  <a href="https://www.youtube.com/@WinterDashESP"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
</p>

---

Home Assistant integration **+ Lovelace card** for [WinterDash][firmware] — mirror your battery
charger's dashboard (the vehicle **hero** image + live status) into Home Assistant.

WinterDash is a small ESP32 display appliance that shows **Victron Blue Smart IP65** charger data
(over BLE) on an LCD and a device-hosted web page — handy for winter-storing cars, motorcycles and
boats. This integration brings that same dashboard into HA: the vehicle cut-out and the charge
status, in one card that matches the on-device screen.

> Not affiliated with or endorsed by Victron Energy. "Victron" and "Blue Smart" are used only to
> describe the chargers WinterDash reads.

---

## What you get

- A **Hero** image entity per board — the exact vehicle cut-out the LCD shows (a WebP with
  transparency), fetched from the board's own web server **server-side** (no browser mixed-content),
  **on change only** (the memory-tight boards are touched at most once per hero change, never on a
  timer).
- A bundled **WinterDash card** — auto-registered as a Lovelace resource, no manual resource step.
  It mirrors the board screen: hero + status word + big voltage + charge phase + a self-drawn
  range bar + current/temperature, themed with your HA theme. Click a readout to open its native
  history.

The charger readouts themselves (voltage / current / temperature / status / phase) are **already**
HA entities from the [ESPHome integration][esphome] — this integration only adds the one piece HA
can't get over the native API: the hero image.

## Requirements

- **Home Assistant 2026.8.2** or newer.
- A **WinterDash** board on your network, added to HA via the ESPHome integration. See the
  [firmware project][firmware] to build/flash one.
- The board's firmware exposes the `winterdash` discovery marker (any current WinterDash build).

## Installation

### HACS (recommended)

[![Open your Home Assistant instance and add this repository to HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=witekin&repository=winterdash-ha&category=integration)

Click the badge above to add this repository to HACS in one step, then **Download** it and
**restart** Home Assistant.

Or add it manually:

1. In HACS, open the three-dot menu → **Custom repositories**.
2. Add `https://github.com/witekin/winterdash-ha` with category **Integration**.
3. Search for **WinterDash** in HACS and install it.
4. **Restart** Home Assistant.

### Manual

Copy `custom_components/winterdash/` into your HA `config/custom_components/` folder and restart HA.

## Setup

1. **Settings → Devices & services → Add integration → “WinterDash”.**
2. Pick your board (the flow lists boards discovered as WinterDash devices).
3. It creates a **Hero** image entity on that board's existing device card, and registers the
   WinterDash card resource.
4. Add a card to a dashboard → search **WinterDash** → pick the board device. Done.

## The card

- One config option: the WinterDash **device** (a picker filtered to this integration).
- Mirrors the board dashboard: hero, status, voltage, phase, range bar (with the charge band),
  current, temperature, and a DEMO badge when the board is in demo mode.
- FAULT / OFFLINE take over with a centered message over a dimmed hero, like the LCD.
- Every readout is clickable → opens Home Assistant's native more-info / history. Zero board
  polling — HA already holds the data.
- Uses your HA theme (light + dark) and resizes to fit the card.

## Notes

- **Icon:** the WinterDash brand icon ships with the integration (the `brand/` folder), so Home
  Assistant shows it on the integration and device pages — no `home-assistant/brands` entry needed.
- **YAML-mode dashboards:** the card resource auto-registers on storage-mode dashboards only. On a
  YAML dashboard, add the resource manually (the URL is logged on setup).

## Links

- Firmware / hardware project: **https://github.com/witekin/winterdash**
- Documentation wiki (build, flash, boards, chargers): **https://github.com/witekin/winterdash/wiki**

## License

[GPL-3.0](LICENSE) — same as the WinterDash firmware.

[firmware]: https://github.com/witekin/winterdash
[esphome]: https://www.home-assistant.io/integrations/esphome/
