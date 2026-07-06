#!/usr/bin/env sh
set -eu

# Copy this file to scripts/update-and-restart.sh, adjust the restart command,
# then run: chmod +x scripts/update-and-restart.sh
#
# The backend runs this script when APP_UPDATE_SCRIPT is configured and the
# user clicks "update and restart" in the version popup.

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Updating cloud-manager from ${APP_CURRENT_VERSION:-unknown} to ${APP_LATEST_VERSION:-unknown}"

git fetch --all --prune
git pull --ff-only

npm install
npm --prefix frontend install
npm --prefix frontend run build

# Choose the command that matches your deployment:
#
# PM2:
# pm2 restart cloud-manager
#
# systemd:
# sudo systemctl restart cloud-manager
#
# plain node with an external supervisor:
# kill -TERM "$PPID"

echo "Update finished. Configure a restart command in scripts/update-and-restart.sh."
