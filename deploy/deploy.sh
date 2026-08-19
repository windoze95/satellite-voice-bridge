#!/usr/bin/env bash
# Run on the DEV machine: sync the repo to the target Mac and (re)install there.
#   deploy/deploy.sh user@airspeeder [remote-dir]
# Secrets and house config are never synced — put .env (and voicebridge.yaml)
# on the target by hand once.
set -euo pipefail

TARGET="${1:?usage: deploy/deploy.sh user@host [remote-dir]}"
REMOTE_DIR="${2:-\$HOME/voicebridge}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

ssh "$TARGET" "mkdir -p $REMOTE_DIR"
rsync -a --delete \
  --exclude .env \
  --exclude voicebridge.yaml \
  --exclude var/ \
  --exclude node_modules/ \
  --exclude dist/ \
  --exclude .git/ \
  "$REPO_DIR/" "$TARGET:$REMOTE_DIR/"
ssh -t "$TARGET" "cd $REMOTE_DIR && bash deploy/install.sh"
