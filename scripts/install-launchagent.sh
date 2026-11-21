#!/usr/bin/env bash
set -euo pipefail

LABEL="dev.steadytube"
OLD_LABEL="dev.free-and-stable-tube"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
if [[ -z "${BUN_BIN}" ]]; then
  for candidate in "${HOME}/.bun/bin/bun" "/opt/homebrew/bin/bun" "/usr/local/bin/bun"; do
    if [[ -x "${candidate}" ]]; then
      BUN_BIN="${candidate}"
      break
    fi
  done
fi

if [[ -z "${BUN_BIN}" || ! -x "${BUN_BIN}" ]]; then
  echo "Error: bun binary not found. Install Bun (https://bun.sh) or pass BUN_BIN=/path/to/bun." >&2
  exit 1
fi

CONFIG_DIR="${HOME}/.config/steadytube"
CONFIG_FILE="${CONFIG_DIR}/config.json"
CACHE_DIR="${HOME}/Library/Caches/steadytube"
LOG_DIR="${HOME}/Library/Logs/steadytube"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
OLD_PLIST_PATH="${PLIST_DIR}/${OLD_LABEL}.plist"

mkdir -p "${CONFIG_DIR}" "${CACHE_DIR}" "${LOG_DIR}" "${PLIST_DIR}"

if [[ ! -f "${CONFIG_FILE}" ]]; then
  cat > "${CONFIG_FILE}" <<'EOF'
{
  "host": "127.0.0.1",
  "port": 8787,
  "logLevel": "info",
  "playback": {
    "enableBgutilPot": true,
    "bgutilPotUrl": "http://127.0.0.1:4416",
    "authFallback": {
      "enabled": false,
      "cookiesFromBrowser": "firefox",
      "firefoxProfile": ""
    },
    "ephemeralBuffer": {
      "enabled": true,
      "maxCacheBytes": 2147483648,
      "ttlSeconds": 3600,
      "maxFormatHeight": 1080
    }
  }
}
EOF
  echo "Created default config at ${CONFIG_FILE}"
else
  echo "Keeping existing config at ${CONFIG_FILE}"
fi

LAUNCHER_BIN="${REPO_DIR}/scripts/steadytube"
chmod +x "${LAUNCHER_BIN}"

SERVICE_PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.bun/bin:${HOME}/.local/bin:${HOME}/.deno/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${LAUNCHER_BIN}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${SERVICE_PATH}</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>BUN_BIN</key>
    <string>${BUN_BIN}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/launchd.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/launchd.stderr.log</string>
</dict>
</plist>
EOF

DOMAIN="gui/$(id -u)"

# Clean up legacy free-and-stable-tube LaunchAgent if present
launchctl bootout "${DOMAIN}/${OLD_LABEL}" 2>/dev/null || true
rm -f "${OLD_PLIST_PATH}"

launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "${PLIST_PATH}"
launchctl kickstart -k "${DOMAIN}/${LABEL}" 2>/dev/null || true

echo ""
echo "Installed and started LaunchAgent: ${PLIST_PATH}"
echo "Logs:   ${LOG_DIR}/daemon.log"
echo "Config: ${CONFIG_FILE}"
echo "Verify: curl -s http://127.0.0.1:8787/api/v1/stats"
