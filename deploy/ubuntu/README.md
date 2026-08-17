# Ubuntu Server Deployment

Deploy Clownin on a fresh Ubuntu 22.04 LTS or 24.04 LTS server.

## What gets installed

| Component | Version | Role |
|-----------|---------|------|
| Node.js | 20 LTS | API server runtime |
| pnpm | 10 | Package manager |
| PostgreSQL | 14+ (system) | Database |
| nginx | latest (system) | Reverse proxy + static files |
| certbot | latest | Let's Encrypt TLS (optional) |
| systemd | system | Process supervision |

## Quick start (5 minutes)

### 1. Provision a server

Minimum specs: **1 vCPU, 1 GB RAM, 10 GB disk** (Ubuntu 22.04 or 24.04).

### 2. SSH in and run the setup script

```bash
# Without a domain (IP-only, no TLS)
sudo bash <(curl -fsSL https://raw.githubusercontent.com/ssdogturdss/clownin/main/deploy/ubuntu/setup.sh)

# With a domain + automatic Let's Encrypt TLS
sudo bash <(curl -fsSL https://raw.githubusercontent.com/ssdogturdss/clownin/main/deploy/ubuntu/setup.sh) \
  --domain clownin.yourdomain.com
```

Or clone the repo first then run locally:

```bash
git clone https://github.com/ssdogturdss/clownin.git /opt/clownin
sudo bash /opt/clownin/deploy/ubuntu/setup.sh --domain clownin.yourdomain.com
```

### 3. Fill in secrets

The script creates `/etc/clownin/app.env` with generated DB credentials and
JWT/session secrets. You must add your own API keys:

```bash
sudo nano /etc/clownin/app.env
```

Required values:

```env
OPENAI_API_KEY=sk-...
ADMIN_USER_IDS=yourusername
REVENUECAT_API_KEY=...
REVENUECAT_PRO_ENTITLEMENT_ID=pro
REVENUECAT_WEBHOOK_SECRET=...
```

Then restart the API:

```bash
sudo systemctl restart clownin-api
sudo systemctl status clownin-api
```

### 4. Verify

```bash
# API health
curl http://localhost:8080/api/health

# Via nginx
curl http://<your-server-ip>/api/health

# Admin panel
open http://<your-server-ip>/admin/
```

## Manual installation

If you prefer step-by-step control:

### Install dependencies

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# pnpm
sudo npm install -g pnpm@10

# PostgreSQL and nginx
sudo apt-get install -y postgresql nginx
```

### Clone and build

```bash
sudo git clone https://github.com/ssdogturdss/clownin.git /opt/clownin
sudo useradd --system --shell /bin/bash --create-home clownin
sudo chown -R clownin:clownin /opt/clownin

sudo -u clownin bash -c "cd /opt/clownin && pnpm install --frozen-lockfile"
sudo -u clownin bash -c "cd /opt/clownin && pnpm typecheck:libs"
sudo -u clownin bash -c "cd /opt/clownin && pnpm --filter @workspace/api-server run build"
sudo -u clownin bash -c "cd /opt/clownin && PORT=8080 pnpm --filter @workspace/admin-panel run build"
```

### Database

```bash
sudo -u postgres psql -c "CREATE USER clownin WITH PASSWORD 'changeme';"
sudo -u postgres psql -c "CREATE DATABASE clownin OWNER clownin;"

# Apply migrations
cd /opt/clownin/lib/db
DATABASE_URL=postgresql://clownin:changeme@localhost:5432/clownin pnpm push
```

### systemd service

```bash
sudo cp /opt/clownin/deploy/ubuntu/clownin-api.service /etc/systemd/system/
sudo sed -i 's|%REPO_DIR%|/opt/clownin|g' /etc/systemd/system/clownin-api.service

sudo mkdir -p /etc/clownin
sudo cp /opt/clownin/.env.example /etc/clownin/app.env
sudo chmod 640 /etc/clownin/app.env
sudo chown root:clownin /etc/clownin/app.env
# Edit /etc/clownin/app.env and fill in values

sudo systemctl daemon-reload
sudo systemctl enable --now clownin-api
```

### nginx

```bash
sudo cp /opt/clownin/deploy/ubuntu/nginx.conf /etc/nginx/sites-available/clownin
sudo sed -i \
  -e 's|%DOMAIN%|_|g' \
  -e 's|%ADMIN_DIST%|/opt/clownin/artifacts/admin-panel/dist|g' \
  -e 's|%API_PORT%|8080|g' \
  /etc/nginx/sites-available/clownin
sudo ln -sf /etc/nginx/sites-available/clownin /etc/nginx/sites-enabled/clownin
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## Updating to a new version

```bash
cd /opt/clownin
sudo -u clownin git pull --ff-only
sudo -u clownin pnpm install --frozen-lockfile
sudo -u clownin pnpm --filter @workspace/api-server run build
sudo -u clownin PORT=8080 pnpm --filter @workspace/admin-panel run build
cd lib/db && sudo -u clownin pnpm push   # run new migrations
sudo systemctl restart clownin-api
```

## Service management

```bash
# Status
sudo systemctl status clownin-api

# Live logs
sudo journalctl -u clownin-api -f

# Restart
sudo systemctl restart clownin-api

# nginx logs
sudo tail -f /var/log/nginx/clownin_error.log
```

## TLS with Let's Encrypt

If you ran `setup.sh` without `--domain`, add TLS later:

```bash
sudo certbot --nginx -d clownin.yourdomain.com
sudo systemctl reload nginx
```

Auto-renewal is configured by certbot automatically via a systemd timer.

## Firewall

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

The API server listens on `localhost:8080` only — never expose port 8080
directly; all external traffic goes through nginx.
