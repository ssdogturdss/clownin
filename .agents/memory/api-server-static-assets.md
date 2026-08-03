---
name: API server static assets
description: How to add and serve static files (images, etc.) from the Express API server that survive esbuild bundling.
---

## Rule
Static files in `artifacts/api-server/src/assets/` must be explicitly copied to `dist/assets/` in `build.mjs`, and served via `express.static()` in `app.ts`.

**Why:** esbuild only bundles JS/TS; non-JS files are silently dropped from `dist/` unless copied manually.

## How to apply
1. Drop the file into `artifacts/api-server/src/assets/`.
2. `build.mjs` already has `cp(srcAssets, distAssets, { recursive: true })` — new files are picked up automatically.
3. `app.ts` serves `/assets` via `express.static(path.join(__dirname, "assets"))` — already wired.
4. Reference the file in code as an absolute URL: `` `${req.protocol}://${req.get("host")}/assets/<filename>` ``.
