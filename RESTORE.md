# Restore Procedure

This document explains how to restore Clownin from this repository into a
working local development environment from scratch.

## Prerequisites

| Tool | Minimum version | Install |
|------|-----------------|---------|
| Node.js | 20 LTS | https://nodejs.org |
| pnpm | 10 | `npm install -g pnpm@latest` |
| PostgreSQL | 14+ | https://www.postgresql.org/download/ |

## Steps

### 1. Clone the repository

```bash
git clone https://github.com/<owner>/clownin.git
cd clownin
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in every required value. At minimum you need:

- `DATABASE_URL` — a running Postgres connection string
- `JWT_SECRET` — any random 48+ character string
- `SESSION_SECRET` — any random 48+ character string
- `ADMIN_USER_IDS` — your username or email to get admin access
- `OPENAI_API_KEY` — an OpenAI API key (for AI features)

Generate secrets quickly:
```bash
openssl rand -base64 48   # run twice — once for JWT_SECRET, once for SESSION_SECRET
```

### 4. Create the database and run migrations

```bash
# Create the database (if it doesn't exist yet)
createdb clownin

# Push the schema
cd lib/db
pnpm push
cd ../..
```

> **Note:** `pnpm push` uses Drizzle Kit to apply `lib/db/migrations/*.sql`
> against the `DATABASE_URL` in your `.env`.

### 5. Start the API server

```bash
pnpm --filter @workspace/api-server run dev
```

The server listens on `$PORT` (default 8080). Verify it's up:

```bash
curl http://localhost:8080/api/health
# → {"status":"ok"}
```

### 6. Start the admin panel (optional)

```bash
pnpm --filter @workspace/admin-panel run dev
```

Opens at http://localhost:5173 by default.

### 7. Start the mobile app (Expo)

```bash
pnpm --filter @workspace/clownin-mobile run dev
```

Scan the QR code with the Expo Go app, or press `w` to open in a browser.

### 8. Type-check the entire monorepo

```bash
pnpm typecheck
```

### 9. Build for production

```bash
# API server
pnpm --filter @workspace/api-server run build

# Admin panel
pnpm --filter @workspace/admin-panel run build

# Mobile (Expo EAS build — requires Expo account)
pnpm --filter @workspace/clownin-mobile run build
```

## Regenerating the API client

If you change `lib/api-spec/openapi.yaml`, regenerate the typed client:

```bash
cd lib/api-spec
npx orval --config orval.config.ts
cd ../..

# Rebuild declarations
cd lib/api-client-react
npx tsc -p tsconfig.json
cd ../..
```

## Running on Replit

On Replit the workflows start automatically. Environment variables are set
through Replit Secrets — no `.env` file is needed. The database is provisioned
via Replit's built-in PostgreSQL integration. Run `cd lib/db && pnpm push` once
after cloning to apply the schema.
