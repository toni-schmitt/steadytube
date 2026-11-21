#!/usr/bin/env bash
set -euo pipefail

LABEL="dev.steadytube"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true

if [[ -f "${PLIST_PATH}" ]]; then
  rm -f "${PLIST_PATH}"
  echo "Removed LaunchAgent plist: ${PLIST_PATH}"
else
  echo "LaunchAgent plist not found at ${PLIST_PATH}"
fi

echo "Done. Your config (~/.config/steadytube) and logs (~/Library/Logs/steadytube) were left intact."
