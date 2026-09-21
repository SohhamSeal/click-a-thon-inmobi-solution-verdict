#!/usr/bin/env bash
# Ensure local ClickHouse is up, .env points at it, and Cloud data is seeded once.
# Called from ./start.sh / ./stack.sh when CLICKHOUSE_LOCAL is not false.

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

env_get() {
  local key="$1"
  [[ -f .env ]] || { printf ''; return 0; }
  awk -v key="$key" 'index($0, key "=")==1 { print substr($0, length(key)+2); exit }' .env | tr -d '\r'
}

env_set() {
  local key="$1" val="$2"
  local tmp
  tmp="$(mktemp)"
  if [[ -f .env ]] && grep -qE "^${key}=" .env; then
    awk -v key="$key" -v val="$val" '
      index($0, key "=")==1 { print key "=" val; next }
      { print }
    ' .env >"$tmp"
    mv "$tmp" .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

env_set_if_missing() {
  local key="$1" val="$2"
  local cur
  cur="$(env_get "$key")"
  if [[ -z "$cur" ]]; then
    env_set "$key" "$val"
  fi
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed."
  docker info >/dev/null 2>&1 || die "Docker is not running."
}

migrate_cloud_creds() {
  local host port secure user password database
  host="$(env_get CLICKHOUSE_HOST)"
  # Already migrated or already local
  if [[ -n "$(env_get CLICKHOUSE_CLOUD_HOST)" ]]; then
    return 0
  fi
  if [[ "$host" != *clickhouse.cloud* ]]; then
    return 0
  fi

  port="$(env_get CLICKHOUSE_PORT)"
  secure="$(env_get CLICKHOUSE_SECURE)"
  user="$(env_get CLICKHOUSE_USER)"
  password="$(env_get CLICKHOUSE_PASSWORD)"
  database="$(env_get CLICKHOUSE_DATABASE)"

  printf 'Preserving Cloud credentials as CLICKHOUSE_CLOUD_* …\n'
  env_set CLICKHOUSE_CLOUD_HOST "$host"
  env_set CLICKHOUSE_CLOUD_PORT "${port:-8443}"
  env_set CLICKHOUSE_CLOUD_SECURE "${secure:-true}"
  env_set CLICKHOUSE_CLOUD_USER "${user:-default}"
  env_set CLICKHOUSE_CLOUD_PASSWORD "$password"
  env_set CLICKHOUSE_CLOUD_DATABASE "${database:-verdict}"
}

point_env_at_local() {
  local port
  port="$(env_get CLICKHOUSE_PORT)"
  # If still on Cloud TLS port, switch to the pinned local HTTP port.
  if [[ "$(env_get CLICKHOUSE_HOST)" == *clickhouse.cloud* ]] || [[ -z "$port" ]] || [[ "$port" == "8443" ]] || [[ "$port" == "8123" ]]; then
    port="${CLICKHOUSE_LOCAL_PORT:-18123}"
  fi
  # Keep a previously pinned free port.
  if [[ -n "$(env_get CLICKHOUSE_LOCAL_PORT)" ]]; then
    port="$(env_get CLICKHOUSE_LOCAL_PORT)"
  else
    env_set CLICKHOUSE_LOCAL_PORT "$port"
  fi

  env_set CLICKHOUSE_HOST localhost
  env_set CLICKHOUSE_PORT "$port"
  env_set CLICKHOUSE_SECURE false
  env_set CLICKHOUSE_USER default
  # Empty password is the ClickHouse Docker default.
  if ! grep -qE '^CLICKHOUSE_PASSWORD=' .env 2>/dev/null; then
    env_set CLICKHOUSE_PASSWORD ""
  else
    # Clear cloud password from the active slot once migrated.
    if [[ -n "$(env_get CLICKHOUSE_CLOUD_PASSWORD)" ]]; then
      env_set CLICKHOUSE_PASSWORD ""
    fi
  fi
  env_set_if_missing CLICKHOUSE_DATABASE verdict
  env_set CLICKHOUSE_LOCAL true
  env_set_if_missing CLICKHOUSE_NATIVE_PORT 19123
}

wait_healthy() {
  local id=""
  id="$(docker compose -f docker-compose.yml -f docker-compose.local-ch.yml ps -q clickhouse 2>/dev/null || true)"
  [[ -n "$id" ]] || die "clickhouse container was not created."
  printf 'Waiting for local ClickHouse'
  for _ in $(seq 1 60); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
    if [[ "$status" == "healthy" ]]; then
      printf ' healthy\n'
      return 0
    fi
    if [[ "$status" == "exited" || "$status" == "dead" ]]; then
      printf ' %s\n' "$status"
      docker compose -f docker-compose.yml -f docker-compose.local-ch.yml logs --tail=40 clickhouse
      die "local ClickHouse failed to start"
    fi
    printf '.'
    sleep 2
  done
  printf ' timed out\n'
  die "local ClickHouse did not become healthy"
}

needs_seed() {
  local port body
  port="$(env_get CLICKHOUSE_PORT)"
  body="$(
    curl -fsS "http://127.0.0.1:${port}/?database=verdict&query=SELECT%20count()%20FROM%20cases" \
      2>/dev/null || echo 0
  )"
  body="$(echo "$body" | tr -d '[:space:]')"
  if [[ -z "$body" || "$body" == "0" || "$body" == *"Code:"* || "$body" == *"Exception"* ]]; then
    return 0
  fi
  return 1
}

main() {
  require_docker
  [[ -f .env ]] || die ".env missing — copy .env.example and fill Cloud credentials once for the initial seed."

  local mode="${1:-up}"
  migrate_cloud_creds
  point_env_at_local

  printf 'Starting local ClickHouse on localhost:%s …\n' "$(env_get CLICKHOUSE_PORT)"
  export CLICKHOUSE_PORT="$(env_get CLICKHOUSE_PORT)"
  export CLICKHOUSE_NATIVE_PORT="$(env_get CLICKHOUSE_NATIVE_PORT)"
  export CLICKHOUSE_DATABASE="$(env_get CLICKHOUSE_DATABASE)"
  export CLICKHOUSE_USER="$(env_get CLICKHOUSE_USER)"
  export CLICKHOUSE_PASSWORD="$(env_get CLICKHOUSE_PASSWORD)"
  export CLICKHOUSE_LOCAL_PORT="$(env_get CLICKHOUSE_LOCAL_PORT)"

  docker compose -f docker-compose.yml -f docker-compose.local-ch.yml up -d clickhouse
  wait_healthy

  if [[ "$mode" == "seed-only" ]] || needs_seed || [[ "${CLICKHOUSE_FORCE_SEED:-}" == "1" ]]; then
    if [[ -z "$(env_get CLICKHOUSE_CLOUD_HOST)" ]]; then
      die "Local CH is empty and CLICKHOUSE_CLOUD_* is unset — cannot seed."
    fi
    printf 'Seeding local ClickHouse from Cloud (first run can take several minutes)…\n'
    local py
    if [[ -x .venv/bin/python ]]; then
      py=".venv/bin/python"
    else
      py="$(command -v python3)"
    fi
    local force=()
    [[ "${CLICKHOUSE_FORCE_SEED:-}" == "1" ]] && force+=(--force)
    "$py" scripts/seed_local_clickhouse.py "${force[@]}"
  else
    printf 'Local ClickHouse already has cases — skipping seed.\n'
  fi

  printf 'Local ClickHouse ready: http://localhost:%s  (Compose DNS: clickhouse:8123)\n' \
    "$(env_get CLICKHOUSE_PORT)"
}

main "${1:-up}"
