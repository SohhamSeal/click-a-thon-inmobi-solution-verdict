#!/usr/bin/env bash
# One command to host Verdict from this repo.
#
#   ./start.sh              start on 3100 / 3081 / 8101
#   ./start.sh down         stop
#   ./start.sh status       show containers
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
  ./start.sh help

Options (up only):
  --with-ai
  --web-port PORT               default: ${WEB_PORT_DEFAULT}
  --mcp-port PORT               default: ${MCP_PORT_DEFAULT}
  --librechat-port PORT         default: ${LIBRECHAT_PORT_DEFAULT}

This script only starts Docker services from THIS checkout. ClickHouse Cloud
must already be reachable (credentials in .env). It does not reload the dataset.
EOF
}

ensure_env() {
  if [[ ! -f .env ]]; then
    cp .env.example .env
    die "Created .env from .env.example. Fill CLICKHOUSE_HOST and CLICKHOUSE_PASSWORD, then run ./start.sh again."
  fi

  local host password
  host="$(awk -F= '$1=="CLICKHOUSE_HOST"{print $2; exit}' .env | tr -d '\r')"
  password="$(awk -F= '$1=="CLICKHOUSE_PASSWORD"{print $2; exit}' .env | tr -d '\r')"
  [[ -n "$host" && "$host" != "your-service.region.provider.clickhouse.cloud" ]] \
    || die "CLICKHOUSE_HOST is not set in .env."
  [[ -n "$password" ]] || die "CLICKHOUSE_PASSWORD is not set in .env."
}

command="up"
if [[ $# -gt 0 ]]; then
  case "$1" in
    up|down|status|help|-h|--help)
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
  up)
    ensure_env
    extra=()
    has_web=false
    has_mcp=false
    has_chat=false
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --web-port) has_web=true ;;
        --mcp-port) has_mcp=true ;;
        --librechat-port) has_chat=true ;;
      esac
      extra+=("$1")
      shift
    done
    [[ "$has_web" == true ]] || extra+=(--web-port "$WEB_PORT_DEFAULT")
    [[ "$has_mcp" == true ]] || extra+=(--mcp-port "$MCP_PORT_DEFAULT")
    [[ "$has_chat" == true ]] || extra+=(--librechat-port "$LIBRECHAT_PORT_DEFAULT")
    exec ./stack.sh up "${extra[@]}"
    ;;
  *)
    die "Unknown command: $command"
    ;;
esac
