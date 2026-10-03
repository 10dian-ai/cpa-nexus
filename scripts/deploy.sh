#!/usr/bin/env bash
# Run from an Ubuntu SSH terminal: bash scripts/deploy.sh up
set -euo pipefail
umask 077

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ACTION="${1:-help}"
PANEL="${2:-}"
cd -- "$PROJECT_DIR"

usage() {
  cat <<'USAGE'
CPA Nexus (Docker Compose v2 required; no host Node.js required)
  bash scripts/deploy.sh init             Create only missing configuration
  bash scripts/deploy.sh up [--1panel]    Build and start; wait for health checks
  bash scripts/deploy.sh update [--1panel] Rebuild local app; keep fixed CPA version
  bash scripts/deploy.sh stop [--1panel]  Stop containers; retain all data
  bash scripts/deploy.sh status [--1panel] Show independent service health
  bash scripts/deploy.sh logs [--1panel]  Show last 100 log lines
  bash scripts/deploy.sh backup [--1panel] Create a private consistent backup
Set PANEL_NETWORK in .env before using --1panel. See docs/cpa-nexus.md.
USAGE
}

case "$ACTION" in init|up|update|stop|status|logs|backup) ;; help|-h|--help) usage; exit 0 ;; *) usage >&2; exit 2 ;; esac
if [[ "$PANEL" != "" && "$PANEL" != "--1panel" ]] || [[ $# -gt 2 ]]; then usage >&2; exit 2; fi
command -v docker >/dev/null || { echo 'Install/start Docker in 1Panel first.' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null 2>&1 || { echo 'Docker is unavailable. Start it in 1Panel, then retry.' >&2; exit 1; }

COMPOSE=(docker compose --env-file "$PROJECT_DIR/.env" --env-file "$PROJECT_DIR/.env.cpa" -f "$PROJECT_DIR/compose.yml")
if [[ "$PANEL" == "--1panel" ]]; then COMPOSE+=(-f "$PROJECT_DIR/ops/compose.1panel.yml"); fi
compose() { "${COMPOSE[@]}" "$@"; }
initialize() {
  docker run --rm --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$PROJECT_DIR,dst=/workspace" --workdir /workspace \
    node:24-alpine node scripts/setup.mjs
}
require_config() {
  [[ -f .env && -f .env.cpa ]] || { echo 'Run bash scripts/deploy.sh init first.' >&2; exit 1; }
}

case "$ACTION" in
  init) initialize ;;
  up|update)
    initialize
    # CPA_IMAGE remains the explicit version/digest in .env.cpa. No latest tag,
    # automatic source pull, account import, or real upstream request is used.
    compose up -d --build --wait --wait-timeout 180
    compose ps
    echo 'Ready. Open APP_URL. Login uses ADMIN_USERNAME / ADMIN_PASSWORD in .env.'
    ;;
  stop) require_config; compose stop ;;
  status) require_config; compose ps --all ;;
  logs) require_config; compose logs --tail 100 ;;
  backup)
    require_config
    [[ "$(compose ps --status running --services)" == *postgres* ]] && \
      [[ "$(compose ps --status running --services)" == *redis* ]] || \
      { echo 'Start PostgreSQL and Redis before backing up.' >&2; exit 1; }
    BACKUP_DIR="$PROJECT_DIR/artifacts/backups/$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p -- "$BACKUP_DIR"
    [[ ! -e "$BACKUP_DIR/COMPLETE" && ! -e "$BACKUP_DIR/config.tar.gz" ]] || \
      { echo 'Backup path already exists. Retry after a second.' >&2; exit 1; }
    PAUSED=()
    while IFS= read -r service; do
      case "$service" in app|worker|cpa|edge|redis) PAUSED+=("$service") ;; esac
    done < <(compose ps --status running --services)
    resume() {
      if [[ " ${PAUSED[*]} " == *" redis "* ]]; then
        compose start redis
        local ready=false
        for ((attempt=0; attempt<30; attempt++)); do
          if compose exec -T redis redis-cli ping >/dev/null 2>&1; then ready=true; break; fi
          sleep 1
        done
        if [[ "$ready" != true ]]; then
          echo 'Redis did not recover. Run deploy.sh up after checking its logs.' >&2
          return 1
        fi
      fi
      if [[ ${#WRITERS[@]} -gt 0 ]]; then compose start "${WRITERS[@]}"; fi
    }
    # Pause writers before snapshots. Redis itself is stopped after SAVE so its
    # RDB and AOF files cannot change during the archive. Existing volumes stay.
    WRITERS=()
    for service in "${PAUSED[@]}"; do [[ "$service" == redis ]] || WRITERS+=("$service"); done
    trap resume EXIT
    if [[ ${#WRITERS[@]} -gt 0 ]]; then compose stop "${WRITERS[@]}"; fi
    compose exec -T postgres pg_dump -U ccm -d commandcode -Fc > "$BACKUP_DIR/postgres.dump"
    compose exec -T redis redis-cli SAVE >/dev/null
    compose stop redis
    REDIS_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$(compose ps -aq redis)")"
    [[ -n "$REDIS_VOLUME" ]] || { echo 'Redis data volume could not be resolved.' >&2; exit 1; }
    docker run --rm --volume "$REDIS_VOLUME:/source:ro" \
      --mount "type=bind,src=$BACKUP_DIR,dst=/backup" \
      node:24-alpine tar -czf /backup/redis.tar.gz -C /source .
    tar -czf "$BACKUP_DIR/config.tar.gz" .env .env.cpa .runtime/cpa
    compose images > "$BACKUP_DIR/images.txt"
    printf 'CPA Nexus backup completed at %s UTC\n' "$(date -u +%FT%T)" > "$BACKUP_DIR/COMPLETE"
    echo "Backup saved to: $BACKUP_DIR"
    echo 'Keep the full folder privately; configuration contains keys and credentials.'
    ;;
esac
