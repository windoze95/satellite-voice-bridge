# Satellite1 custom firmware: the "computer" wake word

Stock [FutureProofHomes Satellite1-ESPHome](https://github.com/FutureProofHomes/Satellite1-ESPHome)
at tag `v0.2.0` plus one overlay package that adds the **"computer"** wake word
(Star Trek style) and a Home Assistant switch per wake word. Stock files are
never edited; `build.sh` clones the stock tag and copies `overlay/config/` on
top, so the flashed image is always exactly "stock + this directory".

## What the overlay adds

- `micro_wake_word` model **computer** — Tater Totterson's
  [microWakeWords V5](https://github.com/TaterTotterson/Tater-Wake-Words)
  model, vendored under `overlay/config/common/wake_words/` (json + tflite).
  Its shipped calibration: probability cutoff 0.95, recall 0.992,
  0.0 false accepts/hour over 9.67 h of validation ambient audio.
  The vendored manifest is stripped to ESPHome's strict manifest schema (the
  repo's `.esphome.json` shape) — the raw Tater json carries extra keys
  (`label`, `tater_native`, `calibration`, …) that fail ESPHome validation
  with a misleading `[micro_wake_word] is an invalid option for [<root>]`.
- Switches `Wake word: Computer` / `Wake word: Hey Jarvis` / `Wake word: Okay
  Nabu` (config category on the Satellite1 device in HA). Defaults after first
  boot: computer ON, jarvis/nabu OFF. Flipping a switch takes effect
  immediately and persists — no reflash. The switch states are re-applied to
  the wake engine every time the voice subscriber (the bridge) connects.
- The stock "Wake word sensitivity" select now also tunes the computer model
  (0.95 / 0.90 / 0.82 for slightly / moderately / very sensitive).

## Build and flash

```sh
firmware/build.sh            # clone stock tag, overlay, validate, compile
firmware/build.sh --flash    # …then OTA to $DEVICE (default 192.168.20.135)
```

Requirements: python ≥3.11 on PATH (homebrew python3.13 works), network for
the first run (stock repo clone, ESPHome external components, ESP-IDF
toolchain). ESPHome is pinned by the stock tag's requirements.txt (2026.4.5
for v0.2.0) — the same toolchain that built the firmware on the device. The
stock OTA has no password; upload needs only LAN access to the device.

After flashing, the device reboots (~30–60 s). The bridge's esphome-client
reconnects and re-arms its voice-assistant subscription on its own — no
service restart needed. The API encryption key, WiFi credentials, and switch
states live in NVS and survive OTA.

## Caveats

- The HA **update entity still tracks stock releases**. Installing a stock
  update from HA replaces this build — wake word reverts to jarvis/nabu —
  until the overlay is rebuilt on the new tag (bump `TAG` in build.sh and
  `esp32_fw_version` in `overlay/config/satellite1.wakewords.yaml`, re-run with
  `--flash`). The overlay pins the reported project version to the stock
  release version so the update entity stays quiet until a genuinely newer
  stock release exists.
- The XMOS DSP firmware is untouched: the overlay inherits the stock
  `xmos_fw_version: v1.0.3` embed, which matches what the device already runs,
  so the boot-time flasher sees a version match and does nothing.
- Recovery: `esphome upload` a stock build of `config/satellite1.yaml` from
  the same clone, or use FutureProofHomes' web installer over USB-C.
