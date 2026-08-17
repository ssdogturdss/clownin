#!/usr/bin/env bash
# =============================================================================
# Clownin — Ubuntu Server Setup Script
# Tested on Ubuntu 22.04 LTS and 24.04 LTS (x86_64)
#
# Usage:
#   sudo bash setup.sh [--domain yourdomain.com] [--repo-dir /opt/clownin]
#
# What this script does:
#   1. Installs Node.js 20, pnpm, PostgreSQL, nginx, certbot
#   2. Creates a dedicated 'clownin' system user
#   3. Clones / updates the repo under --repo-dir
#   4. Installs dependencies and builds the project
#   5. Runs database migrations
#   6. Installs and enables the systemd service
#   7. Configures nginx (HTTP; run with --domain to also get TLS via Let's Encrypt)
# =============================================================================

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
REPO_URL="${CLOWNIN_REPO_URL:-https://github.com/ssdogturdss/clownin.git}"
REPO_DIR="${CLOWNIN_REPO_DIR:-/opt/clownin}"
APP_USER="clownin"
API_PORT="8080"
DOMAIN=""
SETUP_TLS="false"

# ── Argument parsing ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; SETUP_TLS="true"; shift 2 ;;
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Helpers ────────────────────────────────────────────────────────────────────
info()  { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
ok()    { echo -e "\033[1;32m[OK]\033[0m    $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
die()   { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this script as root: sudo bash setup.sh"

# ── 1. System packages ─────────────────────────────────────────────────────────
info "Updating apt and installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl gnupg ca-certificates lsb-release git nginx postgresql postgresql-contrib certbot python3-certbot-nginx

# ── 2. Node.js 20 via NodeSource ───────────────────────────────────────────────
if ! node --version 2>/dev/null | grep -q "^v20"; then
  info "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  ok "Node.js $(node --version) installed"
else
  ok "Node.js $(node --version) already installed"
fi

# ── 3. pnpm ────────────────────────────────────────────────────────────────────
if ! command -v pnpm &>/dev/null; then
  info "Installing pnpm..."
  npm install -g pnpm@10
  ok "pnpm $(pnpm --version) installed"
else
  ok "pnpm $(pnpm --version) already installed"
fi

# ── 4. System user ─────────────────────────────────────────────────────────────
if ! id "$APP_USER" &>/dev/null; then
  info "Creating system user '$APP_USER'..."
  useradd --system --shell /bin/bash --create-home "$APP_USER"
  ok "User '$APP_USER' created"
fi

# ── 5. PostgreSQL database and user ────────────────────────────────────────────
info "Configuring PostgreSQL..."
systemctl enable --now postgresql

DB_NAME="clownin"
DB_USER="clownin"
DB_PASS=$(openssl rand -base64 24 | tr -d '=+/' | head -c 32)

# Only create if they don't exist
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"

DATABASE_URL="postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME"
ok "PostgreSQL ready — database '$DB_NAME'"

# ── 6. Clone / update repo ─────────────────────────────────────────────────────
if [[ -d "$REPO_DIR/.git" ]]; then
  info "Updating existing repo at $REPO_DIR..."
  sudo -u "$APP_USER" git -C "$REPO_DIR" pull --ff-only
else
  info "Cloning repo to $REPO_DIR..."
  git clone "$REPO_URL" "$REPO_DIR"
  chown -R "$APP_USER:$APP_USER" "$REPO_DIR"
fi
ok "Repo ready at $REPO_DIR"

# ── 7. Environment file ────────────────────────────────────────────────────────
ENV_FILE="/etc/clownin/app.env"
mkdir -p /etc/clownin
chmod 750 /etc/clownin
chown root:"$APP_USER" /etc/clownin

if [[ ! -f "$ENV_FILE" ]]; then
  info "Creating environment file at $ENV_FILE..."
  JWT_SECRET=$(openssl rand -base64 48)
  SESSION_SECRET=$(openssl rand -base64 48)

  cat > "$ENV_FILE" <<EOF
# Clownin — production environment
# Edit this file to configure all required variables.
# Restart the service after changes: systemctl restart clownin-api

NODE_ENV=production
PORT=$API_PORT

DATABASE_URL=$DATABASE_URL

# Generate with: openssl rand -base64 48
JWT_SECRET=$JWT_SECRET
SESSION_SECRET=$SESSION_SECRET

# Comma-separated admin usernames or emails
ADMIN_USER_IDS=

# AI providers
OPENAI_API_KEY=

# RevenueCat (required for in-app purchases)
REVENUECAT_API_KEY=
REVENUECAT_PRO_ENTITLEMENT_ID=pro
REVENUECAT_WEBHOOK_SECRET=

# Optional
LOG_LEVEL=info
EOF

  chmod 640 "$ENV_FILE"
  chown root:"$APP_USER" "$ENV_FILE"
  warn "Created $ENV_FILE with generated DB credentials and secrets."
  warn "Fill in ADMIN_USER_IDS, OPENAI_API_KEY, and REVENUECAT_* before starting the service."
else
  # Ensure DATABASE_URL is updated if DB was just created
  ok "Environment file already exists at $ENV_FILE — skipping overwrite."
fi

# ── 8. Install dependencies and build ─────────────────────────────────────────
info "Installing Node.js dependencies..."
sudo -u "$APP_USER" bash -c "cd $REPO_DIR && pnpm install --frozen-lockfile"

info "Building TypeScript libraries..."
sudo -u "$APP_USER" bash -c "cd $REPO_DIR && pnpm typecheck:libs"

info "Building API server..."
sudo -u "$APP_USER" bash -c "cd $REPO_DIR && pnpm --filter @workspace/api-server run build"

info "Building admin panel..."
# Admin panel Vite build needs a PORT value
sudo -u "$APP_USER" bash -c "cd $REPO_DIR && PORT=$API_PORT pnpm --filter @workspace/admin-panel run build"

ok "Build complete"

# ── 9. Database migrations ─────────────────────────────────────────────────────
info "Applying database migrations..."
sudo -u "$APP_USER" bash -c "cd $REPO_DIR && DATABASE_URL=$DATABASE_URL pnpm --filter @workspace/db run push" 2>/dev/null || \
sudo -u "$APP_USER" bash -c "cd $REPO_DIR/lib/db && DATABASE_URL=$DATABASE_URL pnpm push"
ok "Migrations applied"

# ── 10. Install systemd service ────────────────────────────────────────────────
info "Installing systemd service..."
cp "$REPO_DIR/deploy/ubuntu/clownin-api.service" /etc/systemd/system/clownin-api.service
sed -i "s|%REPO_DIR%|$REPO_DIR|g" /etc/systemd/system/clownin-api.service
systemctl daemon-reload
systemctl enable clownin-api
systemctl restart clownin-api
ok "systemd service 'clownin-api' enabled and started"

# ── 11. nginx ─────────────────────────────────────────────────────────────────
info "Configuring nginx..."
ADMIN_DIST="$REPO_DIR/artifacts/admin-panel/dist"

if [[ -n "$DOMAIN" ]]; then
  sed \
    -e "s|%DOMAIN%|$DOMAIN|g" \
    -e "s|%ADMIN_DIST%|$ADMIN_DIST|g" \
    -e "s|%API_PORT%|$API_PORT|g" \
    "$REPO_DIR/deploy/ubuntu/nginx.conf" \
    > /etc/nginx/sites-available/clownin
else
  # No domain — use server_name _;
  sed \
    -e "s|%DOMAIN%|_|g" \
    -e "s|%ADMIN_DIST%|$ADMIN_DIST|g" \
    -e "s|%API_PORT%|$API_PORT|g" \
    "$REPO_DIR/deploy/ubuntu/nginx.conf" \
    > /etc/nginx/sites-available/clownin
fi

ln -sf /etc/nginx/sites-available/clownin /etc/nginx/sites-enabled/clownin
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
ok "nginx configured"

# ── 12. TLS via Let's Encrypt ─────────────────────────────────────────────────
if [[ "$SETUP_TLS" == "true" && -n "$DOMAIN" ]]; then
  info "Obtaining TLS certificate for $DOMAIN..."
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" || \
    warn "certbot failed — check DNS and try: certbot --nginx -d $DOMAIN"
fi

# ── 13. Post-deploy session name coverage check ───────────────────────────────
# Calls /api/admin/session-name-coverage and fails loudly if any sessions are
# unnamed — which means 0007_backfill_session_names.sql did not run.
#
# The check requires two env vars:
#   COVERAGE_CHECK_TOKEN — a signed admin JWT for this server
#   PRODUCTION_API_URL   — base URL of the API (derived from DOMAIN when set)
#
# If either is absent we warn but do not fail the setup, since the JWT token
# cannot be generated until the service has run at least once.
if [[ -n "${COVERAGE_CHECK_TOKEN:-}" ]]; then
  if [[ -n "$DOMAIN" ]]; then
    COVERAGE_API_URL="https://$DOMAIN"
  else
    COVERAGE_API_URL="http://localhost:$API_PORT"
  fi
  info "Running session name coverage check against $COVERAGE_API_URL ..."
  PRODUCTION_API_URL="$COVERAGE_API_URL" \
  COVERAGE_CHECK_TOKEN="$COVERAGE_CHECK_TOKEN" \
  WAIT_SECONDS="20" \
    bash "$REPO_DIR/scripts/check-session-name-coverage.sh" \
    && ok "Session name coverage check passed." \
    || warn "Session name coverage check FAILED — see output above. Run the check manually once the issue is resolved."
else
  warn "Skipping session name coverage check (COVERAGE_CHECK_TOKEN not set)."
  warn "To enable it on future deploys, set COVERAGE_CHECK_TOKEN to a signed admin JWT."
  warn "See scripts/check-session-name-coverage.sh for instructions."
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo "=================================================================="
ok "Clownin setup complete!"
echo ""
echo "  API service:  systemctl status clownin-api"
echo "  API logs:     journalctl -u clownin-api -f"
echo "  nginx logs:   tail -f /var/log/nginx/clownin_error.log"
echo "  Env file:     $ENV_FILE"
echo "  Repo:         $REPO_DIR"
if [[ -n "$DOMAIN" ]]; then
echo "  App:          https://$DOMAIN"
echo "  Admin panel:  https://$DOMAIN/admin/"
echo "  API:          https://$DOMAIN/api/health"
else
echo "  App:          http://<server-ip>"
echo "  Admin panel:  http://<server-ip>/admin/"
echo "  API:          http://<server-ip>/api/health"
fi
echo "=================================================================="
if grep -q "OPENAI_API_KEY=$" "$ENV_FILE" 2>/dev/null; then
  warn "ACTION REQUIRED: Edit $ENV_FILE and set OPENAI_API_KEY, ADMIN_USER_IDS, and RevenueCat keys."
  warn "Then run: systemctl restart clownin-api"
fi
