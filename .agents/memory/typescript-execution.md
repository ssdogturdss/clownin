---
name: TypeScript execution
description: Use bun to run TypeScript files in the API execution sandbox.
---

`bun` is pre-installed at `/nix/store/.../bun-1.3.6/bin/bun` and runs `.ts` files natively.

**Rule:** Executor command for TypeScript: `{ cmd: "bun", args: ["run", filePath] }`.

**Why:** `npx tsx` requires a network fetch on first use (slow, unreliable in sandbox). `bun run` is instant with no extra dependencies.

**How to apply:** `execution.ts` `getExecutorCommand` already uses bun for `typescript`/`ts`. Do not change this back to npx tsx.
