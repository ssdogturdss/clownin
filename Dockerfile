# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: build
#   • Installs all dependencies (dev + prod) so we can compile TS and Vite.
#   • Builds the API server (esbuild → dist/index.mjs).
#   • Builds the admin panel (Vite → dist/public/).
#   • Creates a lean production deploy directory via `pnpm deploy`.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

# corepack ships with Node 20; use it to activate the exact pnpm version from
# the lockfile rather than installing a separate global copy.
RUN corepack enable

WORKDIR /build

# Copy workspace manifests first — these change rarely, so Docker caches the
# expensive `pnpm install` layer unless a dep actually changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY lib/db/package.json               ./lib/db/
COPY lib/api-spec/package.json         ./lib/api-spec/
COPY lib/api-zod/package.json          ./lib/api-zod/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY artifacts/api-server/package.json  ./artifacts/api-server/
COPY artifacts/admin-panel/package.json ./artifacts/admin-panel/
COPY scripts/package.json               ./scripts/

RUN pnpm install --frozen-lockfile

# Copy the full source now that deps are cached.
COPY . .

# Build shared TypeScript project references (lib/db, lib/api-zod, etc.)
RUN pnpm typecheck:libs

# Build the API server (esbuild bundles most deps; externals resolved at runtime)
RUN pnpm --filter @workspace/api-server run build

# Build the admin panel static site.
# PORT is required by the dev-server section of vite.config.ts but is ignored
# during `vite build`; set a placeholder so the config evaluates without error.
# BASE_PATH must match where the admin panel will be served in production.
RUN PORT=3000 BASE_PATH=/admin-panel/ \
    pnpm --filter @workspace/admin-panel run build

# Create a self-contained production directory: production node_modules + dist.
# --ignore-scripts prevents prepare/postinstall hooks from running twice.
RUN pnpm --filter @workspace/api-server deploy --prod --ignore-scripts /app/api

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: production image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS production

# Non-root user for security
RUN addgroup --system clownin && \
    adduser  --system --ingroup clownin --no-create-home clownin

WORKDIR /app

# API server (bundled dist + production node_modules from pnpm deploy)
COPY --from=builder /app/api ./

# Admin panel static build — served by the API server at /admin-panel/
COPY --from=builder /build/artifacts/admin-panel/dist/public ./admin-panel/

# Database migration files — needed when running `db push` from inside the
# container or from a maintenance job.
COPY --from=builder /build/lib/db/migrations ./lib/db/migrations
COPY --from=builder /build/lib/db/drizzle.config.ts ./lib/db/
COPY --from=builder /build/lib/db/package.json ./lib/db/

USER clownin

EXPOSE 8080

ENV NODE_ENV=production \
    PORT=8080 \
    LOG_LEVEL=info

# Health check: hits the /api/healthz endpoint which verifies DB connectivity.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "\
    require('http').get( \
      'http://localhost:' + (process.env.PORT || 8080) + '/api/healthz', \
      r => process.exit(r.statusCode < 500 ? 0 : 1) \
    ).on('error', () => process.exit(1))"

CMD ["node", "--enable-source-maps", "dist/index.mjs"]
