#!/usr/bin/env bash
set -euo pipefail

DIST_DIR="${1:-dist}"
BIN="${DIST_DIR}/steadytube"

if [[ ! -x "${BIN}" ]]; then
  echo "Missing executable: ${BIN}" >&2
  exit 1
fi

VERSION_OUT="$("${BIN}" --version)"
echo "Version: ${VERSION_OUT}"
echo "${VERSION_OUT}" | grep -q "^steadytube " || {
  echo "Unexpected --version output: ${VERSION_OUT}" >&2
  exit 1
}

TMP_DIR="$(mktemp -d)"
PORT=$((20000 + (RANDOM % 20000)))
cleanup() {
  if [[ -n "${PID:-}" ]]; then
    kill "${PID}" 2>/dev/null || true
    wait "${PID}" 2>/dev/null || true
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

STEADYTUBE_PORT="${PORT}" \
STEADYTUBE_CACHE_DIR="${TMP_DIR}/cache" \
STEADYTUBE_LOG_DIR="${TMP_DIR}/logs" \
STEADYTUBE_CONFIG="${TMP_DIR}/config.json" \
  "${BIN}" >/dev/null 2>&1 &
PID=$!

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/api/v1/stats" > "${TMP_DIR}/stats.json"; then
    break
  fi
  sleep 0.2
done

if [[ ! -s "${TMP_DIR}/stats.json" ]]; then
  echo "Daemon failed to answer /api/v1/stats on port ${PORT}" >&2
  exit 1
fi

grep -q '"name":"steadytube"' "${TMP_DIR}/stats.json" || {
  echo "Unexpected stats response: $(cat "${TMP_DIR}/stats.json")" >&2
  exit 1
}

# Verify trailing-slash route normalization
STATUS_SLASH="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/v1/stats/")"
[[ "${STATUS_SLASH}" == "200" ]] || {
  echo "Expected 200 on /api/v1/stats/, got ${STATUS_SLASH}" >&2
  exit 1
}

# Verify invalid video ID & path traversal return 400
STATUS_BAD_VID="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/v1/videos/bad!id")"
[[ "${STATUS_BAD_VID}" == "400" ]] || {
  echo "Expected 400 on invalid video id, got ${STATUS_BAD_VID}" >&2
  exit 1
}
STATUS_BAD_PB="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/videoplayback?v=..%2F..%2Fetc%2Fpasswd&fid=137")"
[[ "${STATUS_BAD_PB}" == "400" ]] || {
  echo "Expected 400 on traversal videoplayback v param, got ${STATUS_BAD_PB}" >&2
  exit 1
}

# Verify DNS-rebinding Host guard and cross-origin guard
STATUS_BAD_HOST="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' "http://127.0.0.1:${PORT}/api/v1/stats")"
[[ "${STATUS_BAD_HOST}" == "403" ]] || {
  echo "Expected 403 on non-loopback Host header, got ${STATUS_BAD_HOST}" >&2
  exit 1
}
STATUS_BAD_ORIGIN="$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example.com' "http://127.0.0.1:${PORT}/api/v1/stats")"
[[ "${STATUS_BAD_ORIGIN}" == "403" ]] || {
  echo "Expected 403 on remote web Origin, got ${STATUS_BAD_ORIGIN}" >&2
  exit 1
}
STATUS_NULL_ORIGIN="$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: null' "http://127.0.0.1:${PORT}/api/v1/stats")"
[[ "${STATUS_NULL_ORIGIN}" == "200" ]] || {
  echo "Expected 200 on Electron/FreeTube Origin: null, got ${STATUS_NULL_ORIGIN}" >&2
  exit 1
}

echo "Smoke test passed: $(cat "${TMP_DIR}/stats.json")"
