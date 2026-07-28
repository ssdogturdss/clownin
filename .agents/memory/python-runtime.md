---
name: Python runtime
description: Python is not in the default nix modules and must be explicitly installed.
---

The default `.replit` only includes `nodejs-24`. Python is absent from PATH by default.

**Fix:** Install via `installProgrammingLanguage({ language: "python-3.11" })` in CodeExecution. This adds python3 to PATH permanently.

**Why:** Without this, all Python project executions return "command not found" silently.

**How to apply:** Already installed. If the workspace is reset or cloned, re-run the install step. Verify with `which python3`.
