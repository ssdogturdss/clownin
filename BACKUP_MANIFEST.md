# Backup Manifest

| Field | Value |
|-------|-------|
| **Project name** | Clownin |
| **Backup date** | 2026-08-17 |
| **Branch** | main |
| **Framework** | pnpm monorepo |
| **Runtime** | Node.js 24.13.0 |
| **Package manager** | pnpm 10.26.1 |
| **Database** | PostgreSQL (Drizzle ORM) |
| **Mobile framework** | Expo SDK 52 (React Native) |
| **API framework** | Express.js |
| **Frontend framework** | React 19 + Vite |
| **TypeScript version** | ~5.9.3 |
| **Build tool (API)** | esbuild (custom `build.mjs`) |
| **Build tool (web)** | Vite 7 |
| **API spec tool** | orval v8.23.0 |

## Build Command

```bash
pnpm --filter @workspace/api-server run build   # API server
pnpm --filter @workspace/admin-panel run build   # Admin panel
```

## Start Command

```bash
pnpm --filter @workspace/api-server run dev      # Development
node artifacts/api-server/dist/app.js            # Production
```

## Type Check Command

```bash
pnpm typecheck
```

## Database Migration Command

```bash
cd lib/db && pnpm push
```

## External Services

| Service | Purpose | Required |
|---------|---------|---------|
| PostgreSQL | Primary database | Yes |
| OpenAI | Default AI provider | Yes |
| RevenueCat | Subscription billing | For IAP features |
| Anthropic | Optional AI provider | No |
| Gemini | Optional AI provider | No |
| OpenRouter | Optional AI provider | No |
| Replit Repls | Code execution sandbox | For code running |

## Required Environment Variables

See `.env.example` for the full list with documentation.

Minimum required to boot:
- `DATABASE_URL`
- `JWT_SECRET`
- `SESSION_SECRET`
- `OPENAI_API_KEY`

## Tracked Files

353 files tracked in git (excluding node_modules, dist, .expo, .cache)

## Migration Files

| File | Description |
|------|-------------|
| `0000_curious_red_hulk.sql` | Baseline schema (users, projects, files, servers) |
| `0001_panoramic_blizzard.sql` | Subscriptions, AI providers, promo codes |
| `0002_preview_fields.sql` | Preview URL fields |
| `0003_chunky_robin_chapel.sql` | Conversation sessions and messages |
| `0004_session_id.sql` | Session ID column |
| `0005_backfill_session_id.sql` | Backfill existing sessions |
| `0006_conversation_session_names.sql` | Session name column |
| `0007_backfill_session_names.sql` | Backfill session names |
| `0008_subscription_source.sql` | Subscription source tracking |

## Project Directory Tree

```
clownin/
├── .env.example              Environment variable template
├── .gitignore
├── BACKUP_MANIFEST.md        This file
├── BACKUP_STATUS.md          Build/test status at backup time
├── README.md                 Project overview and setup guide
├── RESTORE.md                Step-by-step restore procedure
├── package.json              Workspace root (pnpm)
├── pnpm-workspace.yaml       Workspace packages definition
├── pnpm-lock.yaml            Locked dependency tree
├── tsconfig.json             Root TypeScript project references
│
├── artifacts/
│   ├── api-server/           Express REST API
│   │   ├── build.mjs         esbuild build script
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── app.ts        Express app entry point
│   │       ├── routes/       API route handlers
│   │       └── ...
│   ├── admin-panel/          React + Vite admin UI
│   │   ├── src/
│   │   │   ├── pages/        Admin page components
│   │   │   └── lib/api.ts    Typed API client
│   │   └── vite.config.ts
│   ├── clownin-mobile/       Expo React Native app
│   │   ├── app/              Expo Router file-based routes
│   │   ├── components/       Shared UI components
│   │   ├── contexts/         React context providers
│   │   ├── hooks/            Custom React hooks
│   │   └── assets/           Images, fonts
│   └── demo-video/           Animated demo video
│
├── lib/
│   ├── api-spec/             OpenAPI 3.1 specification
│   │   └── openapi.yaml
│   ├── api-client-react/     Generated React Query hooks
│   │   └── src/generated/
│   ├── api-zod/              Generated Zod validation schemas
│   │   └── src/generated/
│   └── db/                   Database layer
│       ├── drizzle.config.ts
│       ├── migrations/       SQL migration files
│       └── src/schema/       Drizzle table definitions
│
└── scripts/                  Utility scripts
```
