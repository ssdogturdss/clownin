---
name: Docker Compose readiness
description: Portable stack startup should wait on real database connectivity, not only container health metadata.
---

Use an application-level PostgreSQL readiness check before applying migrations in Compose.

**Why:** Some container runtimes cannot execute Docker healthcheck commands reliably, and a database process being started does not mean it is ready to accept migrations. A retrying SQL connection check works in both cases.

**How to apply:** Keep the one-shot migration service dependent only on database start, make it wait for a successful SQL query, then make the API depend on migration success.