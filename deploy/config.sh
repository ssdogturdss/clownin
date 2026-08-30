#!/bin/bash
# Ubuntu 20.04 — First-time deployment script
# Usage: curl -fsSL https://your-server/deploy.sh | bash
set -euo pipefail

REPO_URL="https://github.com/your-org/your-repo.git"
APP_DIR="/var/www/app"
DOMAIN="example.com"
APP_USER="www-data"
NODE_VERSION="20"

echo "==> Updating system packages"
apt-get update -qq && apt-get upgrade -y -qq

echo "==> Installing Node.js $NODE_VERSION"
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y nodejs

echo "==> Installing pnpm"
corepack enable
corepack prepare pnpm@latest --activate

echo "==> Installing PostgreSQL 16"
sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt focal-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add -
apt-get update -qq
apt-get install -y postgresql-16

echo "==> Installing Nginx + Certbot"
apt-get install -y nginx certbot python3-certbot-nginx

echo "==> Cloning repository"
mkdir -p $(dirname $APP_DIR)
git clone "$REPO_URL" "$APP_DIR"
chown -R $APP_USER:$APP_USER "$APP_DIR"

echo "==> Installing dependencies"
cd "$APP_DIR"
pnpm install --frozen-lockfile

echo "==> Building application"
pnpm run build

echo "==> Configuring Nginx"
cp deploy/nginx.conf.example /etc/nginx/sites-available/$DOMAIN
ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

echo "==> Obtaining SSL certificate"
certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos -m admin@$DOMAIN

echo "==> Setting up systemd service"
cp deploy/app.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable app
systemctl start app

echo ""
echo "✓ Deployment complete. App running at https://$DOMAIN"
echo "  Check status: systemctl status app"
echo "  View logs:    journalctl -u app -f"
