# Clownin

An AI-powered coding agent mobile app. Users create projects, write code, and run it — all from their phone. An AI agent (backed by OpenAI / Anthropic / Gemini / OpenRouter / xAI Grok) assists in real time via a chat interface.

## Architecture

```
clownin/
├── artifacts/
│   ├── api-server/        Express.js REST API (TypeScript + Drizzle ORM)
│   ├── admin-panel/       React + Vite admin dashboard
│   ├── clownin-mobile/    Expo (React Native) iOS + Android mobile app
│   └── demo-video/        Animated demo video (Vite)
├── lib/
│   ├── db/                Drizzle ORM schema + PostgreSQL migrations
│   ├── api-spec/          OpenAPI 3.1 spec (source of truth)
│   ├── api-client-react/  Auto-generated typed React Query hooks (orval)
│   └── api-zod/           Auto-generated Zod schemas (orval)
└── scripts/               Utility scripts
```

### Backend — `artifacts/api-server`

- **Runtime:** Node.js 20, TypeScript, built with esbuild
- **Framework:** Express.js
- **ORM:** Drizzle ORM → PostgreSQL
- **Auth:** JWT (access tokens) + bcrypt password hashing
- **AI:** Pluggable provider system — OpenAI, Anthropic, Gemini, OpenRouter, xAI Grok; configured per-instance from the admin panel
- **Execution:** Sandboxed code execution on remote servers via SSH
- **Subscriptions:** RevenueCat webhook listener + server-side sync

### Frontend — `artifacts/admin-panel`

- **Stack:** React 19, Vite, TypeScript, Tailwind CSS v4, shadcn/ui
- **Auth:** JWT bearer token (admin-only)
- **Features:** User management, AI provider config, promo code management, redemption history

### Mobile — `artifacts/clownin-mobile`

- **Framework:** Expo SDK 54 (React Native)
- **Navigation:** Expo Router (file-based)
- **State:** React Query + context (AuthContext, SubscriptionContext)
- **Monetization:** RevenueCat (in-app purchases)
- **Features:** Project management, code editor, AI chat agent, file browser, terminal/output, secrets vault

### Database

- **Engine:** PostgreSQL 14+ (any hosted Postgres instance)
- **Migrations:** Drizzle Kit — SQL files in `lib/db/migrations/`
- **Schema:** Users, projects, project files, execution servers, conversation sessions/messages, AI provider configs, promo codes, user secrets (AES-256-GCM encrypted)

### External Services

| Service | Purpose | Required? |
|---------|---------|-----------|
| OpenAI / Anthropic / Gemini / OpenRouter / xAI | AI coding agent | At least one |
| RevenueCat | Subscription management (iOS & Android) | Optional |
| Remote SSH server | Sandboxed code execution | Optional |

---

## Requirements

- Node.js 20 LTS
- pnpm 10+
- PostgreSQL 14+

---

## Installation

```bash
git clone https://github.com/<owner>/clownin.git
cd clownin
pnpm install
```

## Environment Setup

```bash
cp .env.example .env
# Edit .env and fill in all required values
```

See [`.env.example`](.env.example) for every variable with inline documentation.

**Minimum required variables to start:**

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | 48+ char random string (`openssl rand -base64 48`) |
| `SESSION_SECRET` | 48+ char random string (`openssl rand -base64 48`) |
| `ADMIN_USER_IDS` | Comma-separated usernames/emails with admin access |
| `OPENAI_API_KEY` | Fallback AI provider key (or configure one via admin panel) |
| `CORS_ORIGIN` | *(Production)* Comma-separated allowed origins, e.g. `https://clownin.app` |

---

## Development

Run each service in a separate terminal:

```bash
# API server (default port 8080)
PORT=8080 pnpm --filter @workspace/api-server run dev

# Admin panel (any available port)
PORT=5174 BASE_PATH=/admin-panel/ pnpm --filter @workspace/admin-panel run dev

# Mobile app (Expo)
pnpm --filter @workspace/clownin-mobile run dev
```

---

## Database

```bash
# Apply migrations to your database
cd lib/db && pnpm push

# Generate a new migration after schema changes
cd lib/db && pnpm generate

# Run pending migrations (production-safe)
cd lib/db && pnpm migrate
```

---

## Build

```bash
# Build shared TypeScript libraries
pnpm typecheck:libs

# Build the API server
pnpm --filter @workspace/api-server run build

# Build the admin panel (produces static files)
PORT=3000 BASE_PATH=/admin-panel/ pnpm --filter @workspace/admin-panel run build
```

---

## Type Checking

```bash
# All packages
pnpm typecheck

# Individual
pnpm --filter @workspace/api-server run typecheck
PORT=3000 BASE_PATH=/admin-panel/ pnpm --filter @workspace/admin-panel run typecheck
```

---

## Testing

```bash
# API server unit + integration tests
pnpm --filter @workspace/api-server run test

# Watch mode
pnpm --filter @workspace/api-server run test:watch
```

---

## Docker

### Build and run with Docker Compose (recommended)

```bash
# 1. Configure environment
cp .env.example .env
#    Set JWT_SECRET, SESSION_SECRET, ADMIN_USER_IDS, and at least one AI key.
#    DATABASE_URL is set automatically by docker-compose (points to the db service).

# 2. Build and start
docker compose up --build

# 3. Apply database migrations (first run only)
docker compose exec api sh -c "cd lib/db && pnpm push"
```

The API and admin panel are then available at:
- API: `http://localhost:8080/api/`
- Admin panel: `http://localhost:8080/admin-panel/`
- Health check: `http://localhost:8080/api/healthz`

### Build image only

```bash
docker build -t clownin .
docker run -p 8080:8080 \
  -e DATABASE_URL="postgresql://..." \
  -e JWT_SECRET="..." \
  -e SESSION_SECRET="..." \
  clownin
```

---

## Production (Ubuntu VPS / bare metal)

Run the API server as a standard Node.js process behind an Nginx reverse proxy.

```bash
# 1. Install Node.js 20, pnpm, PostgreSQL, and Nginx on your server
# 2. Clone the repo and install deps
git clone https://github.com/<owner>/clownin.git
cd clownin && pnpm install

# 3. Set environment variables
cp .env.example .env && nano .env

# 4. Apply database migrations
cd lib/db && pnpm migrate && cd ../..

# 5. Build
pnpm --filter @workspace/api-server run build
PORT=3000 BASE_PATH=/admin-panel/ pnpm --filter @workspace/admin-panel run build

# 6. Copy admin panel dist next to the API server dist so it is served at /admin-panel/
cp -r artifacts/admin-panel/dist artifacts/api-server/dist/admin-panel

# 7. Start
PORT=8080 node artifacts/api-server/dist/index.mjs
```

**Nginx:** copy [`deploy/nginx.conf.example`](deploy/nginx.conf.example) to
`/etc/nginx/sites-available/clownin`, fill in your domain, and obtain a free
TLS certificate with `sudo certbot --nginx -d <your-domain>`.

A `systemd` service unit keeps the process alive across reboots:

```ini
# /etc/systemd/system/clownin.service
[Unit]
Description=Clownin API Server
After=network.target

[Service]
EnvironmentFile=/opt/clownin/.env
WorkingDirectory=/opt/clownin
ExecStart=/usr/bin/node artifacts/api-server/dist/index.mjs
Restart=always
User=clownin

[Install]
WantedBy=multi-user.target
```

---

## Deployment

The application runs as a standard Node.js process and can be deployed to any environment that supports Node.js 20 and PostgreSQL:

- **Docker / Docker Compose** — see above
- **Ubuntu VPS** — see `deploy/ubuntu/`
- **Fly.io** — `fly launch` (uses the `Dockerfile`)
- **Railway / Render** — point at the repo; set env vars from `.env.example`
- **Any Node.js host** — build with `pnpm run build`, start with `node artifacts/api-server/dist/index.mjs`

The admin panel is a static Vite build served by the API server at `/admin-panel/` in Docker. In Replit it runs as a separate Vite dev process.

---

## Repository Structure

```
.github/workflows/ci.yml    CI: type-check → build → test (no Replit required)
Dockerfile                  Multi-stage production image (API + admin panel)
docker-compose.yml          API server + PostgreSQL for local/server deployment
deploy/nginx.conf.example   Annotated Nginx reverse-proxy config with TLS notes
.env.example                Every environment variable documented
```

### CI

GitHub Actions runs on every push and pull request to `main`:

1. Install dependencies (`pnpm install --frozen-lockfile`)
2. Type-check all packages (API server, admin panel, mobile)
3. Build the API server and admin panel
4. Run the full test suite (258 tests) against a real PostgreSQL instance

No Replit account or secrets required to run CI.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `PORT environment variable is required` | Set `PORT=8080` (dev server) or run `vite build` (production build auto-detects) |
| `DATABASE_URL is required` | Copy `.env.example` → `.env` and fill in a valid Postgres URL |
| `No AI provider configured` | Set `OPENAI_API_KEY` in `.env`, or add a key in the admin panel |
| Admin panel shows 404 | In Docker: built-in; in dev: run the admin panel separately on its own port |
| `Invalid or expired token` | JWT token has expired — log in again; check `JWT_SECRET` hasn't changed |
| DB migration fails | Ensure `DATABASE_URL` points to a reachable Postgres instance; run `cd lib/db && pnpm push` |
