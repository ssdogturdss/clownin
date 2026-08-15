/**
 * Per-project environment variables API.
 *
 * GET    /projects/:id/env         — list keys + masked values (never raw)
 * POST   /projects/:id/env         — upsert a key (body: { key, value })
 * DELETE /projects/:id/env/:key    — delete by key name
 */

import { Router, type IRouter } from "express";
import { db, projectsTable, projectEnvVarsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { encrypt, isValidEnvKey } from "../lib/envCrypto";

const router: IRouter = Router();

// Helper: verify project ownership and return projectId
async function resolveProject(
  req: Parameters<Parameters<typeof router.get>[1]>[0],
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): Promise<number | null> {
  const { userId } = getUser(req);
  const projectId = parseInt(
    Array.isArray(req.params.id) ? req.params.id[0] : req.params.id,
    10,
  );
  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return null;
  }
  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
    .limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return null;
  }
  return projectId;
}

// ── GET /projects/:id/env — list keys + masked values ────────────────────────
router.get("/projects/:id/env", requireAuth, async (req, res): Promise<void> => {
  const projectId = await resolveProject(req, res);
  if (projectId === null) return;

  // SELECT key only — values are never returned to clients, even masked.
  // Decryption is reserved for user-initiated execution paths (/execute, /serve).
  const rows = await db
    .select({ key: projectEnvVarsTable.key })
    .from(projectEnvVarsTable)
    .where(eq(projectEnvVarsTable.projectId, projectId))
    .orderBy(projectEnvVarsTable.key);

  const vars = rows.map((r) => ({ key: r.key, maskedValue: "••••••••" }));

  res.json({ vars });
});

// ── POST /projects/:id/env — upsert ──────────────────────────────────────────
router.post("/projects/:id/env", requireAuth, async (req, res): Promise<void> => {
  const projectId = await resolveProject(req, res);
  if (projectId === null) return;

  const { key, value } = req.body ?? {};

  if (typeof key !== "string" || !isValidEnvKey(key)) {
    res.status(400).json({
      error: "key must be a valid identifier (letters, digits, underscores; cannot start with a digit)",
    });
    return;
  }
  if (typeof value !== "string") {
    res.status(400).json({ error: "value must be a string" });
    return;
  }
  if (value.length > 65_536) {
    res.status(400).json({ error: "value too large (max 64 KiB)" });
    return;
  }

  const encryptedValue = encrypt(value);

  // Upsert: insert or update on conflict (projectId, key)
  await db
    .insert(projectEnvVarsTable)
    .values({ projectId, key, encryptedValue })
    .onConflictDoUpdate({
      target: [projectEnvVarsTable.projectId, projectEnvVarsTable.key],
      set: { encryptedValue, updatedAt: new Date() },
    });

  res.status(204).end();
});

// ── DELETE /projects/:id/env/:key — delete by name ───────────────────────────
router.delete("/projects/:id/env/:key", requireAuth, async (req, res): Promise<void> => {
  const projectId = await resolveProject(req, res);
  if (projectId === null) return;

  const keyName = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;

  await db
    .delete(projectEnvVarsTable)
    .where(
      and(
        eq(projectEnvVarsTable.projectId, projectId),
        eq(projectEnvVarsTable.key, keyName),
      ),
    );

  res.status(204).end();
});

export default router;
