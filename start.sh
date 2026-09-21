#!/usr/bin/env bash
# One command to host Verdict from this repo.
#
#   ./start.sh              start on 3100 / 3081 / 8101 (+ local ClickHouse)
#   ./start.sh down         stop
#   ./start.sh status       show containers
#   ./start.sh seed         re-seed local CH from Cloud (CLICKHOUSE_CLOUD_*)
#
# Ports can be overridden:
#   ./start.sh --web-port 3200 --mcp-port 8201 --librechat-port 3181
#   ./start.sh --with-ai

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

WEB_PORT_DEFAULT=3100
MCP_PORT_DEFAULT=8101
LIBRECHAT_PORT_DEFAULT=3081

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage:
  ./start.sh [up] [options]     Start the full stack (default)
  ./start.sh down               Stop the stack
  ./start.sh status             Show running services
  ./start.sh seed               Force re-seed local ClickHouse from Cloud
  ./start.sh help

Options (up only):
  --with-ai
  --dev                         next dev + bind-mount web/ (default)
  --prod                        production Next image (rebuild to see UI changes)
  --web-port PORT               default: ${WEB_PORT_DEFAULT}
  --mcp-port PORT               default: ${MCP_PORT_DEFAULT}
  --librechat-port PORT         default: ${LIBRECHAT_PORT_DEFAULT}

By default this starts a local ClickHouse on CLICKHOUSE_LOCAL_PORT (18123), seeds it
once from CLICKHOUSE_CLOUD_* credentials, and points the console at localhost.
Set CLICKHOUSE_LOCAL=false in .env to keep using ClickHouse Cloud only.
EOF
}

ensure_env() {
  if [[ ! -f .env ]]; then
    cp .env.example .env
    die "Created .env from .env.example. For the first seed, put Cloud credentials in CLICKHOUSE_* (they will be moved to CLICKHOUSE_CLOUD_* on first ./start.sh)."
  fi

  local host local_flag password
  host="$(awk -F= '$1=="CLICKHOUSE_HOST"{print $2; exit}' .env | tr -d '\r')"
  local_flag="$(awk -F= '$1=="CLICKHOUSE_LOCAL"{print $2; exit}' .env | tr -d '\r')"

  if [[ "$local_flag" == "false" ]]; then
    [[ -n "$host" && "$host" != "your-service.region.provider.clickhouse.cloud" ]] \
      || die "CLICKHOUSE_HOST is not set in .env."
    password="$(awk -F= '$1=="CLICKHOUSE_PASSWORD"{print $2; exit}' .env | tr -d '\r')"
    [[ -n "$password" ]] || die "CLICKHOUSE_PASSWORD is not set in .env (Cloud mode)."
  fi
}

command="up"
if [[ $# -gt 0 ]]; then
  case "$1" in
    up|down|status|seed|help|-h|--help)
      command="$1"
      shift
      ;;
    --*)
      command="up"
      ;;
    *)
      die "Unknown command: $1 (try ./start.sh help)"
      ;;
  esac
fi

case "$command" in
  help|-h|--help)
    usage
    exit 0
    ;;
  down)
    exec ./stack.sh down
    ;;
  status)
    exec ./stack.sh status
    ;;
  seed)
    ensure_env
    export CLICKHOUSE_FORCE_SEED=1
    exec bash "$ROOT_DIR/scripts/ensure_local_clickhouse.sh" seed-only
    ;;
  up)
    ensure_env
    extra=()
    has_web=false
    has_mcp=false
    has_chat=false
    has_prod=false
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --web-port) has_web=true ;;
        --mcp-port) has_mcp=true ;;
        --librechat-port) has_chat=true ;;
        --prod) has_prod=true ;;
      esac
      extra+=("$1")
      shift
    done
    [[ "$has_web" == true ]] || extra+=(--web-port "$WEB_PORT_DEFAULT")
    [[ "$has_mcp" == true ]] || extra+=(--mcp-port "$MCP_PORT_DEFAULT")
    [[ "$has_chat" == true ]] || extra+=(--librechat-port "$LIBRECHAT_PORT_DEFAULT")
    # Default the console to next dev so a save under web/ shows up without a rebuild.
    [[ "$has_prod" == true ]] || extra+=(--dev)
    exec ./stack.sh up "${extra[@]}"
    ;;
  *)
    die "Unknown command: $command"
    ;;
esac
