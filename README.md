# Clownin

An AI-powered coding agent mobile app. Users create projects, write code, and run it — all from their phone. An AI agent (backed by OpenAI / Anthropic / Gemini / OpenRouter) assists in real time via a chat interface.

## Architecture

```
clownin/
├── artifacts/
│   ├── api-server/        Express.js REST API (TypeScript + Drizzle ORM)
│   ├── admin-panel/       React + Vite admin dashboard
│   ├── clownin-mobile/    Expo (React Native) iOS + Android mobile app
│   └── demo-video/        Animated demo video (Remotion/Vite)
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
- **AI:** Pluggable provider system — OpenAI, Anthropic, Gemini, OpenRouter, configurable per-user
- **Execution:** Sandboxed code execution on remote Replit Repls
- **Subscriptions:** RevenueCat webhook listener + server-side sync

### Frontend — `artifacts/admin-panel`

- **Stack:** React 19, Vite, TypeScript, Tailwind CSS v4, shadcn/ui
- **Auth:** JWT bearer token (admin-only)
- **Features:** User management, AI provider config, promo code management, redemption history

### Mobile — `artifacts/clownin-mobile`

- **Framework:** Expo SDK 52 (React Native)
- **Navigation:** Expo Router (file-based)
- **State:** React Query + context (AuthContext, SubscriptionContext)
- **Monetization:** RevenueCat (in-app purchases)
- **Features:** Project management, Monaco-style code editor, AI chat agent, file browser, terminal/output, secrets vault

### Database

- **Engine:** PostgreSQL (Replit managed DB or any Postgres instance)
- **Migrations:** Drizzle Kit — SQL files in `lib/db/migrations/`
- **Schema:** Users, projects, project files, execution servers, conversation sessions, messages, AI provider configs, promo codes, user secrets (AES-256-GCM encrypted)

### External Services

| Service | Purpose |
|---------|---------|
| OpenAI / Anthropic / Gemini / OpenRouter | AI coding agent |
| RevenueCat | Subscription management (iOS & Android) |
| Replit Repls (remote) | Sandboxed code execution servers |

## Requirements

- Node.js 20 LTS
- pnpm 10+
- PostgreSQL 14+

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

See [`.env.example`](.env.example) for the full list of required variables with explanations.

## Development

```bash
# API server (port $PORT, default 8080)
pnpm --filter @workspace/api-server run dev

# Admin panel (port 5173)
pnpm --filter @workspace/admin-panel run dev

# Mobile app (Expo)
pnpm --filter @workspace/clownin-mobile run dev
```

## Database

```bash
# Apply migrations
cd lib/db && pnpm push

# Generate a new migration after schema changes
cd lib/db && pnpm generate
```

## Type Checking

```bash
pnpm typecheck
```

## Build

```bash
# API server
pnpm --filter @workspace/api-server run build

# Admin panel
pnpm --filter @workspace/admin-panel run build
```

## API Client Regeneration

After editing `lib/api-spec/openapi.yaml`:

```bash
cd lib/api-spec && npx orval --config orval.config.ts
cd lib/api-client-react && npx tsc -p tsconfig.json
```

## Deployment

The project is designed to run on Replit:

1. Fork / import the repo into Replit
2. Set all required secrets in Replit's Secrets panel
3. Run `cd lib/db && pnpm push` to apply the schema
4. Start the workflows from the Replit UI

For self-hosting, build the API server (`pnpm build` in `artifacts/api-server`), then run `node dist/app.js` behind a reverse proxy (nginx / Caddy).

## Backup & Restore

See [RESTORE.md](RESTORE.md) for the full step-by-step restore procedure.
See [BACKUP_MANIFEST.md](BACKUP_MANIFEST.md) for build metadata.
