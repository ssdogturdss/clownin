# Backup Status

**Date:** 2026-08-17
**Commit:** (see git log)

## Type Check

| Artifact | Status | Notes |
|----------|--------|-------|
| `artifacts/api-server` | ✅ Pass | |
| `artifacts/admin-panel` | ✅ Pass | |
| `artifacts/clownin-mobile` | ✅ Pass | |
| `artifacts/demo-video` | ⚠️ Pre-existing failures | 4 TS errors in video animation helpers — `window`/`document` not in tsconfig lib, and a Framer Motion type mismatch. These existed before this backup and do not affect the running application (the video artifact is a Vite browser app with `lib: ["DOM"]` at runtime; the typecheck target is misconfigured). |
| `artifacts/mockup-sandbox` | ⚠️ Pre-existing failure | Cascade from demo-video tsconfig. Does not affect functionality. |
| `lib/db` | ✅ Pass | |
| `lib/api-client-react` | ✅ Pass | |
| `lib/api-zod` | ✅ Pass | |

## Secret Scan

✅ No secrets, credentials, or API keys found committed in source files.

## Database

✅ 9 migration files preserved in `lib/db/migrations/`.
✅ Schema pushed and verified against the live database before backup.

## Known Issues / What Could Not Be Backed Up

- **Production database content** — excluded intentionally (contains user data). Only the schema and migrations are in this repo.
- **`.env` values** — all real credentials live in Replit Secrets and are excluded from the repo. See `.env.example` for required variables.
- **Replit-specific runtime** — the `REPLIT_CONNECTORS_HOSTNAME`, `REPL_IDENTITY`, and `WEB_REPL_RENEWAL` env vars are injected by the Replit platform and cannot be replicated outside Replit without replacing the RevenueCat and GitHub connector integrations with direct SDK credentials.
