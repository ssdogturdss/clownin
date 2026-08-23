# Clownin

A mobile-first coding playground — a true Replit clone branded as Clownin 🤡. Users can sign up, create projects in JavaScript or Python, edit files in a syntax-highlighted editor, and run code with live SSE-streamed terminal output.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm db:migrate` — apply checked-in database migrations
- Required env: `DATABASE_URL` — Postgres connection string
- Optional env: `JWT_SECRET` — JWT signing key (defaults to `clownin-secret-dev` in dev)

## Optional demo data

- Create sample projects only when needed:
  `DEMO_USER_PASSWORD='temporary-password' pnpm db:seed`
- Authentication is disabled for the current single-user deployment; the API
  runs requests as the system user.

## Stack

- pnpm workspaces, Node.js 20+, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM (`users`, `projects`, `project_files`)
- Auth: JWT via `jsonwebtoken` + `bcryptjs` (no native deps)
- Validation: Zod (v3), `drizzle-zod`
- Code execution: Node.js `child_process.spawn` → SSE stream (10s timeout)
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts
- `lib/db/src/schema/` — Drizzle table definitions (users, projects, project-files)
- `artifacts/api-server/src/routes/` — auth, projects, files, execution route handlers
- `artifacts/api-server/src/lib/auth.ts` — JWT sign/verify + `requireAuth` middleware
- `artifacts/api-server/src/lib/seed.ts` — demo data seeder (runs on startup, idempotent)
- `lib/api-client-react/src/generated/` — generated React Query hooks (do not edit)
- `lib/api-zod/src/generated/` — generated Zod schemas (do not edit)

## Architecture decisions

- **`type: number` in OpenAPI for integer IDs**: Orval v8 generates `z.int()` (Zod v4 syntax) for `type: integer`. Since the project uses Zod v3, all integer fields use `type: number` in the spec.
- **`lib/api-zod/src/index.ts` exports only `generated/api`**: Orval generates both `generated/api.ts` and `generated/types/` with identical exports, causing TS2308 conflicts. The index only re-exports `./generated/api` to avoid ambiguity.
- **`bcryptjs` not `bcrypt`**: bcrypt requires native compilation (node-gyp). bcryptjs is pure JS and installs cleanly.
- **SSE execution endpoint**: The `/api/projects/:id/execute` endpoint streams `{ type: "stdout"|"stderr"|"exit", payload }` JSON objects as SSE events. It writes a temp file, spawns a subprocess, and enforces a 10-second SIGKILL timeout.

## Product

- **Auth**: Register/login with email + password; JWT tokens (7-day expiry)
- **Projects**: Create JS or Python projects; each auto-gets a default main file
- **Files**: Full CRUD on files within projects; content stored as text in DB
- **Execution**: Run any project file; real subprocess output streamed live via SSE

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after changing `openapi.yaml`
- After codegen, `pnpm run typecheck:libs` to verify generated lib types
- Do not use `type: integer` in openapi.yaml — use `type: number` (Zod v3 compat)
- Do not add `format: email` to string fields — Orval v8 generates `z.email()` (Zod v4)
- The seed runs on every server start but is idempotent (checks for demo user first)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
