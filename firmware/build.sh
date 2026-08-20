#!/usr/bin/env bash
# Build (and optionally OTA-flash) the custom Satellite1 firmware:
# stock FutureProofHomes Satellite1-ESPHome at $TAG plus the overlay/ files
# (the "computer" wake word and per-wake-word switches).
#
#   firmware/build.sh            # validate + compile only
#   firmware/build.sh --flash    # compile, then OTA to $DEVICE
#
# The stock tag pins ESPHome via its requirements.txt (2026.4.5 for v0.2.0),
# matching the toolchain that built the firmware currently on the device.
set -euo pipefail

TAG=v0.2.0
DEVICE="${DEVICE:-192.168.20.135}"
DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$DIR/.build"
REPO="$BUILD/Satellite1-ESPHome"
VENV="$BUILD/venv"

mkdir -p "$BUILD"
if [[ ! -d "$REPO" ]]; then
  git clone --depth 1 --branch "$TAG" https://github.com/FutureProofHomes/Satellite1-ESPHome "$REPO"
fi

# ESPHome 2026.x needs Python ≥3.11; the macOS system python3 is 3.9.
PYTHON="$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3)"
if [[ ! -d "$VENV" ]]; then
  "$PYTHON" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet -r "$REPO/requirements.txt"

# Overlay: adds files only; stock files are never modified, so a git-clean
# checkout plus the overlay is always exactly "stock + this diff".
cp -R "$DIR/overlay/config/." "$REPO/config/"

esphome config "$REPO/config/satellite1.computer.yaml" > /dev/null
echo "config valid"
esphome compile "$REPO/config/satellite1.computer.yaml"

if [[ "${1:-}" == "--flash" ]]; then
  esphome upload "$REPO/config/satellite1.computer.yaml" --device "$DEVICE"
fi
