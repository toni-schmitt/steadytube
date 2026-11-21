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

echo "Smoke test passed: $(cat "${TMP_DIR}/stats.json")"
