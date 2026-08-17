#!/usr/bin/env bash
# =============================================================================
# Clownin — Production Update Script
#
# Usage (run as root or with sudo from the server):
#   cd /opt/clownin
#   sudo bash deploy/ubuntu/update.sh [--domain clownin.yourdomain.com]
#
# This script is the documented update path for existing Ubuntu installations.
# It performs: git pull → install deps → build → migrate → restart → coverage check.
#
# The coverage check calls /api/admin/session-name-coverage and exits non-zero
# if any sessions are unnamed, indicating that migration
# 0007_backfill_session_names.sql did not run or did not complete.
#
# Optional environment variables:
#   COVERAGE_CHECK_TOKEN  Signed admin JWT for the production API.
#                         Required for the coverage check to run.
#                         See scripts/check-session-name-coverage.sh for how
#                         to generate one.
#   COVERAGE_SKIP         Set to "1" to skip the coverage check entirely.
# =============================================================================

set -euo pipefail

APP_USER="clownin"
API_PORT="8080"
REPO_DIR="/opt/clownin"
DOMAIN=""

# ── Argument parsing ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)   DOMAIN="$2";   shift 2 ;;
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Helpers ────────────────────────────────────────────────────────────────────
info()  { echo "[INFO]  $*"; }
ok()    { echo "[OK]    $*"; }
warn()  { echo "[WARN]  $*"; }
die()   { echo "[ERROR] $*" >&2; exit 1; }

[[ -d "$REPO_DIR" ]] || die "Repo directory not found: $REPO_DIR"

# ── 1. Pull latest code ────────────────────────────────────────────────────────
info "Pulling latest code..."
sudo -u "$APP_USER" git -C "$REPO_DIR" pull --ff-only
ok "Code updated"

# ── 2. Install dependencies ────────────────────────────────────────────────────
info "Installing dependencies..."
sudo -u "$APP_USER" bash -c "cd $REPO_DIR && pnpm install --frozen-lockfile"
ok "Dependencies installed"

# ── 3. Build ──────────────────────────────────────────────────────────────────
info "Building API server..."
sudo -u "$APP_USER" bash -c "cd $REPO_DIR && pnpm --filter @workspace/api-server run build"

info "Building admin panel..."
sudo -u "$APP_USER" bash -c "cd $REPO_DIR && PORT=$API_PORT pnpm --filter @workspace/admin-panel run build"
ok "Build complete"

# ── 4. Run migrations ─────────────────────────────────────────────────────────
info "Applying database migrations..."
# Load DATABASE_URL from the environment file
ENV_FILE="/etc/clownin/app.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi
sudo -u "$APP_USER" bash -c "cd $REPO_DIR/lib/db && pnpm push"
ok "Migrations applied"

# ── 5. Restart the service ─────────────────────────────────────────────────────
info "Restarting clownin-api service..."
systemctl restart clownin-api

# Wait for the service to become healthy before running the coverage check
info "Waiting for service to become healthy..."
for i in $(seq 1 15); do
  if curl --silent --fail --max-time 3 "http://localhost:$API_PORT/api/healthz" >/dev/null 2>&1; then
    ok "Service is healthy (attempt $i)"
    break
  fi
  if [[ "$i" -eq 15 ]]; then
    warn "Service did not respond to /api/health in time — proceeding anyway."
  fi
  sleep 2
done

# ── 6. Session name coverage check ───────────────────────────────────────────
if [[ "${COVERAGE_SKIP:-0}" == "1" ]]; then
  warn "Coverage check skipped (COVERAGE_SKIP=1)."
elif [[ -z "${COVERAGE_CHECK_TOKEN:-}" ]]; then
  warn "Skipping session name coverage check — COVERAGE_CHECK_TOKEN is not set."
  warn "Set it to a signed admin JWT and re-run this script to verify the migration."
  warn "See scripts/check-session-name-coverage.sh for generation instructions."
else
  if [[ -n "$DOMAIN" ]]; then
    COVERAGE_API_URL="https://$DOMAIN"
  else
    COVERAGE_API_URL="http://localhost:$API_PORT"
  fi
  info "Running session name coverage check against $COVERAGE_API_URL ..."
  PRODUCTION_API_URL="$COVERAGE_API_URL" \
  COVERAGE_CHECK_TOKEN="$COVERAGE_CHECK_TOKEN" \
  WAIT_SECONDS="0" \
    bash "$REPO_DIR/scripts/check-session-name-coverage.sh" \
    && ok "Session name coverage check passed." \
    || die "Session name coverage check FAILED — see output above.\n       Backfill migration: lib/db/migrations/0007_backfill_session_names.sql"
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo "=================================================================="
ok "Update complete!"
echo ""
echo "  API logs:  journalctl -u clownin-api -f"
echo "  Status:    systemctl status clownin-api"
echo "=================================================================="
