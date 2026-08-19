#!/usr/bin/env bash
# Run ON the target Mac (airspeeder) from the repo checkout:
#   bash deploy/install.sh
# Builds, installs the LaunchDaemon + log rotation, and (re)starts the service.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
USER_NAME="$(whoami)"
LABEL=com.lothal.voicebridge

if [[ ! -f "$DIR/.env" ]]; then
  echo "ERROR: $DIR/.env is missing. Copy it over by hand (never via git):" >&2
  echo "  scp .env <this-host>:$DIR/.env" >&2
  exit 1
fi
if [[ ! -f "$DIR/voicebridge.yaml" ]]; then
  echo "NOTE: no voicebridge.yaml — the service will run with defaults." >&2
  echo "  cp $DIR/voicebridge.example.yaml $DIR/voicebridge.yaml  # then edit" >&2
fi

cd "$DIR"
npm ci
npm run build
mkdir -p var/log

sed -e "s|@@NODE@@|$NODE|g" -e "s|@@DIR@@|$DIR|g" -e "s|@@USER@@|$USER_NAME|g" \
  deploy/$LABEL.plist > "/tmp/$LABEL.plist"
sed -e "s|@@DIR@@|$DIR|g" -e "s|@@USER@@|$USER_NAME|g" \
  deploy/voicebridge.newsyslog.conf > /tmp/voicebridge.newsyslog.conf

echo "Installing LaunchDaemon (sudo required)…"
sudo cp "/tmp/$LABEL.plist" "/Library/LaunchDaemons/$LABEL.plist"
sudo mkdir -p /etc/newsyslog.d
sudo cp /tmp/voicebridge.newsyslog.conf /etc/newsyslog.d/voicebridge.conf
sudo launchctl bootout "system/$LABEL" 2>/dev/null || true
sudo launchctl bootstrap system "/Library/LaunchDaemons/$LABEL.plist"

echo
sudo launchctl print "system/$LABEL" | sed -n '1,6p'
echo
echo "voicebridge installed. Logs: $DIR/var/log/  Telemetry: $DIR/var/commands.jsonl"
echo "Keep this Mac awake while on AC power (one-time):"
echo "  sudo pmset -a sleep 0 && sudo pmset -a disablesleep 1"
