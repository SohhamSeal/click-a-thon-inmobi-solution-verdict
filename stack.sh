#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

COMPOSE=(docker compose)
ALL_PROFILES=(--profile recommendations --profile selfhosted)

usage() {
  cat <<'EOF'
Usage:
  ./stack.sh                         Interactive menu
  ./stack.sh up [options]            Start the product
  ./stack.sh down                    Stop the complete stack
  ./stack.sh status|ps               Show service status
  ./stack.sh logs [SERVICE]          Follow logs (all services by default)
  ./stack.sh rebuild [options]       Rebuild product images
  ./stack.sh doctor [--with-ai]      Validate Docker and Compose configuration
  ./stack.sh help

Options (up and rebuild):
  --with-ai                 Start the optional Cursor recommendations profile
  --dev                     Console as next dev, bind-mounted (saves in web/ reload the UI)
  --prod                    Console as the production Next image (rebuild to see changes)
  --web-port PORT           Host port for the console (default: WEB_PORT in .env, else 3000)
  --mcp-port PORT           Host port for the ClickHouse MCP server (default: MCP_PORT in .env, else 8001)
  --librechat-port PORT     Host port for LibreChat (default: LIBRECHAT_PORT in .env, else 3080)

Examples:
  ./stack.sh up --dev --web-port 3100 --mcp-port 8101
  ./stack.sh up --with-ai --web-port 3100

Port overrides apply to this invocation only unless you also add them to .env. If you change
MCP_PORT, update .cursor/mcp.json (or Cursor MCP settings) to match.

The AI profile requires CURSOR_API_KEY in the environment or root .env. Starting it makes the
UI control available, but the browser toggle remains off until a user explicitly enables it.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed or not on PATH."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is unavailable."
  docker info >/dev/null 2>&1 || die "Docker is not running."
}

env_file_value() {
  local key="$1"
  local value=""

  if [[ -f .env ]]; then
    value="$(
      awk -v key="$key" '
        index($0, key "=") == 1 {
          print substr($0, length(key) + 2)
          exit
        }
      ' .env
    )"
  fi
  value="${value%$'\r'}"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "$value"
}

require_cursor_key() {
  local key="${CURSOR_API_KEY:-}"
  if [[ -z "$key" ]]; then
    key="$(env_file_value CURSOR_API_KEY)"
  fi
  [[ -n "$key" ]] || die \
    "CURSOR_API_KEY is empty. Add it to .env before using --with-ai."
}

validate_cursor_ca() {
  local ca="${CURSOR_CA_CERT:-}"
  if [[ -z "$ca" ]]; then
    ca="$(env_file_value CURSOR_CA_CERT)"
  fi
  if [[ -n "$ca" && ! -r "$ca" ]]; then
    die "CURSOR_CA_CERT is not a readable file: $ca"
  fi
}

apply_compose_files() {
  local files=(-f docker-compose.yml)
  if [[ "${STACK_WEB_DEV:-false}" == true ]]; then
    files+=(-f docker-compose.web-dev.yml)
  fi
  # Local ClickHouse overlay (default). Set CLICKHOUSE_LOCAL=false to use Cloud only.
  local use_local
  use_local="$(env_file_value CLICKHOUSE_LOCAL)"
  if [[ "${CLICKHOUSE_LOCAL:-}" == "false" || "$use_local" == "false" ]]; then
    COMPOSE=(docker compose "${files[@]}")
  else
    files+=(-f docker-compose.local-ch.yml)
    COMPOSE=(docker compose "${files[@]}")
  fi
}

compose_for_mode() {
  local with_ai="$1"
  shift

  apply_compose_files
  if [[ "$with_ai" == true ]]; then
    RECOMMENDATIONS_ENABLED=true \
      "${COMPOSE[@]}" --profile recommendations "$@"
  else
    RECOMMENDATIONS_ENABLED=false \
      "${COMPOSE[@]}" "$@"
  fi
}

validate_compose() {
  local with_ai="$1"
  compose_for_mode "$with_ai" config --quiet
}

wait_for_ai() {
  local container_id status
  container_id="$("${COMPOSE[@]}" --profile recommendations ps -q cursor-cli-agent)"
  [[ -n "$container_id" ]] || die "Cursor CLI container was not created."

  printf 'Waiting for Cursor CLI service health'
  for _ in {1..45}; do
    status="$(docker inspect \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$container_id" 2>/dev/null || true)"
    case "$status" in
      healthy)
        printf ' healthy\n'
        return 0
        ;;
      unhealthy|exited|dead)
        printf ' %s\n' "$status"
        "${COMPOSE[@]}" --profile recommendations logs --tail=40 cursor-cli-agent
        return 1
        ;;
      *)
        printf '.'
        sleep 2
        ;;
    esac
  done

  printf ' timed out\n'
  "${COMPOSE[@]}" --profile recommendations logs --tail=40 cursor-cli-agent
  return 1
}

port_value() {
  local cli="$1"
  local env_key="$2"
  local default="$3"
  local file=""

  if [[ -n "$cli" ]]; then
    printf '%s' "$cli"
    return 0
  fi
  if [[ -n "${!env_key:-}" ]]; then
    printf '%s' "${!env_key}"
    return 0
  fi
  file="$(env_file_value "$env_key")"
  if [[ -n "$file" ]]; then
    printf '%s' "$file"
    return 0
  fi
  printf '%s' "$default"
}

validate_port() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || die "$label must be a number, got: $value"
  (( value >= 1 && value <= 65535 )) || die "$label must be between 1 and 65535, got: $value"
}

apply_port_overrides() {
  local web_port mcp_port librechat_port

  web_port="$(port_value "${STACK_WEB_PORT:-}" WEB_PORT 3000)"
  mcp_port="$(port_value "${STACK_MCP_PORT:-}" MCP_PORT 8001)"
  librechat_port="$(port_value "${STACK_LIBRECHAT_PORT:-}" LIBRECHAT_PORT 3080)"

  validate_port "web port" "$web_port"
  validate_port "MCP port" "$mcp_port"
  validate_port "LibreChat port" "$librechat_port"

  export WEB_PORT="$web_port"
  export MCP_PORT="$mcp_port"
  export LIBRECHAT_PORT="$librechat_port"
  export NEXT_PUBLIC_CHAT_URL="http://localhost:${librechat_port}"
}

print_stack_urls() {
  local with_ai="$1"
  printf 'Console:    http://localhost:%s\n' "$WEB_PORT"
  if [[ "${STACK_WEB_DEV:-false}" == true ]]; then
    printf '            next dev — edits under web/ reload without rebuilding\n'
  else
    printf '            production image — rebuild web to see code changes\n'
  fi
  printf 'LibreChat:  http://localhost:%s\n' "$LIBRECHAT_PORT"
  printf 'MCP (SSE):  http://localhost:%s/sse\n' "$MCP_PORT"
  if [[ "$with_ai" == true ]]; then
    local cursor_port
    cursor_port="$(port_value "" CURSOR_AGENT_PORT 8157)"
    validate_port "Cursor agent port" "$cursor_port"
    printf 'Cursor AI:  http://localhost:%s\n' "$cursor_port"
  fi
}

start_stack() {
  local with_ai="$1"

  require_docker
  apply_port_overrides
  apply_compose_files

  # Local CH is the default booth path — start + seed before the rest of the stack.
  local use_local
  use_local="$(env_file_value CLICKHOUSE_LOCAL)"
  if [[ "${CLICKHOUSE_LOCAL:-}" != "false" && "$use_local" != "false" ]]; then
    bash "$ROOT_DIR/scripts/ensure_local_clickhouse.sh" up
    # Re-read ports/hosts after ensure rewrote .env
    apply_port_overrides
    apply_compose_files
  fi

  if [[ "$with_ai" == true ]]; then
    require_cursor_key
    validate_cursor_ca
  else
    # Switching from AI mode back to core mode must actually stop the optional service.
    "${COMPOSE[@]}" --profile recommendations stop cursor-cli-agent >/dev/null 2>&1 || true
  fi

  validate_compose "$with_ai"
  compose_for_mode "$with_ai" up -d --build

  if [[ "$with_ai" == true ]]; then
    if ! wait_for_ai; then
      die "Cursor CLI did not become healthy; the core product remains running."
    fi
    printf 'Verdict is running with optional AI recommendations available.\n'
    printf 'Enable the UI toggle in the console when wanted.\n'
  else
    printf 'Verdict is running (AI recommendations disabled).\n'
  fi
  print_stack_urls "$with_ai"
  if [[ -n "${STACK_MCP_PORT:-}" ]]; then
    printf 'Note: MCP port changed — point .cursor/mcp.json at http://localhost:%s/sse\n' \
      "$MCP_PORT"
  fi
  local ch_host ch_port
  ch_host="$(env_file_value CLICKHOUSE_HOST)"
  ch_port="$(env_file_value CLICKHOUSE_PORT)"
  printf 'ClickHouse: %s:%s\n' "${ch_host:-localhost}" "${ch_port:-18123}"
}

rebuild_stack() {
  local with_ai="$1"

  require_docker
  apply_port_overrides
  if [[ "$with_ai" == true ]]; then
    require_cursor_key
    validate_cursor_ca
  fi
  validate_compose "$with_ai"
  if [[ "$with_ai" == true ]]; then
    compose_for_mode true build --pull verdict web
    # The official installer resolves a release dynamically, so its cached layer must be skipped
    # when the user explicitly asks for a refresh.
    compose_for_mode true build --pull --no-cache cursor-cli-agent
  else
    compose_for_mode false build --pull
  fi
}

stop_stack() {
  require_docker
  docker compose -f docker-compose.yml -f docker-compose.web-dev.yml -f docker-compose.local-ch.yml \
    "${ALL_PROFILES[@]}" down
}

show_status() {
  require_docker
  docker compose -f docker-compose.yml -f docker-compose.web-dev.yml -f docker-compose.local-ch.yml \
    "${ALL_PROFILES[@]}" ps
}

follow_logs() {
  require_docker
  if [[ $# -gt 0 ]]; then
    "${COMPOSE[@]}" "${ALL_PROFILES[@]}" logs --tail=200 -f "$1"
  else
    "${COMPOSE[@]}" "${ALL_PROFILES[@]}" logs --tail=200 -f
  fi
}

doctor() {
  local with_ai="$1"
  require_docker
  if [[ "$with_ai" == true ]]; then
    require_cursor_key
    validate_cursor_ca
  fi
  validate_compose "$with_ai"
  printf 'Docker and Compose configuration are valid%s.\n' \
    "$([[ "$with_ai" == true ]] && printf ' for AI mode' || true)"
}

STACK_WEB_PORT=""
STACK_MCP_PORT=""
STACK_LIBRECHAT_PORT=""
STACK_WITH_AI=false
STACK_WEB_DEV=false

parse_stack_options() {
  STACK_WITH_AI=false
  STACK_WEB_DEV=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --with-ai)
        STACK_WITH_AI=true
        shift
        ;;
      --dev)
        STACK_WEB_DEV=true
        shift
        ;;
      --prod)
        STACK_WEB_DEV=false
        shift
        ;;
      --web-port)
        [[ $# -ge 2 ]] || die "--web-port requires a value."
        STACK_WEB_PORT="$2"
        shift 2
        ;;
      --mcp-port)
        [[ $# -ge 2 ]] || die "--mcp-port requires a value."
        STACK_MCP_PORT="$2"
        shift 2
        ;;
      --librechat-port)
        [[ $# -ge 2 ]] || die "--librechat-port requires a value."
        STACK_LIBRECHAT_PORT="$2"
        shift 2
        ;;
      *)
        die "Unknown option: $1"
        ;;
    esac
  done

}

interactive_menu() {
  [[ -t 0 ]] || {
    usage
    exit 2
  }

  cat <<'EOF'

Verdict stack
  1) Start product
  2) Start product + Cursor AI recommendations
  3) Stop stack
  4) Show status
  5) Follow logs
  6) Validate configuration
  7) Exit
EOF

  local choice
  read -r -p "Choose [1-7]: " choice
  case "$choice" in
    1) start_stack false ;;
    2) start_stack true ;;
    3) stop_stack ;;
    4) show_status ;;
    5) follow_logs ;;
    6)
      read -r -p "Validate AI mode too? [y/N]: " choice
      [[ "$choice" =~ ^[Yy]$ ]] && doctor true || doctor false
      ;;
    7) exit 0 ;;
    *) die "Unknown menu choice: $choice" ;;
  esac
}

main() {
  local command="${1:-menu}"
  if [[ $# -gt 0 ]]; then
    shift
  fi

  case "$command" in
    menu) interactive_menu ;;
    up)
      parse_stack_options "$@"
      start_stack "$STACK_WITH_AI"
      ;;
    down)
      [[ $# -eq 0 ]] || die "down does not accept options."
      stop_stack
      ;;
    status|ps)
      [[ $# -eq 0 ]] || die "status does not accept options."
      show_status
      ;;
    logs)
      [[ $# -le 1 ]] || die "logs accepts at most one service name."
      follow_logs "$@"
      ;;
    rebuild)
      parse_stack_options "$@"
      rebuild_stack "$STACK_WITH_AI"
      ;;
    doctor)
      if [[ $# -eq 0 ]]; then
        doctor false
      elif [[ $# -eq 1 && "$1" == "--with-ai" ]]; then
        doctor true
      else
        die "doctor accepts no option or --with-ai only."
      fi
      ;;
    help|-h|--help)
      [[ $# -eq 0 ]] || die "help does not accept options."
      usage
      ;;
    *)
      usage >&2
      die "Unknown command: $command"
      ;;
  esac
}

main "$@"
