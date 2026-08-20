/**
 * User secrets vault API.
 *
 * GET    /secrets                                    — list vault entries (id, name, description; values never returned)
 * POST   /secrets                                    — create or update a secret { name, value, description? }
 * DELETE /secrets/:id                                — delete a vault entry
 * POST   /projects/:id/env/from-secret/:secretId    — decrypt vault secret and upsert it into project env
 */

import { Router, type IRouter } from "express";
import { db, userSecretsTable, projectsTable, projectEnvVarsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { encrypt, decrypt, isValidEnvKey } from "../lib/envCrypto";

const router: IRouter = Router();

// ── GET /secrets — list ──────────────────────────────────────────────────────
router.get("/secrets", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const rows = await db
    .select({
      id: userSecretsTable.id,
      name: userSecretsTable.name,
      description: userSecretsTable.description,
      createdAt: userSecretsTable.createdAt,
      updatedAt: userSecretsTable.updatedAt,
    })
    .from(userSecretsTable)
    .where(eq(userSecretsTable.userId, userId))
    .orderBy(userSecretsTable.name);

  res.json({ secrets: rows });
});

// ── POST /secrets — create or update ─────────────────────────────────────────
router.post("/secrets", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const { name, value, description } = req.body ?? {};

  if (typeof name !== "string" || !isValidEnvKey(name)) {
    res.status(400).json({
      error: "name must be a valid identifier (letters, digits, underscores; cannot start with a digit)",
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
  const desc = typeof description === "string" ? description.slice(0, 200) : null;

  const encryptedValue = encrypt(value);

  await db
    .insert(userSecretsTable)
    .values({ userId, name, encryptedValue, description: desc })
    .onConflictDoUpdate({
      target: [userSecretsTable.userId, userSecretsTable.name],
      set: { encryptedValue, description: desc, updatedAt: new Date() },
    });

  res.status(204).end();
});

// ── DELETE /secrets/:id — delete ─────────────────────────────────────────────
router.delete("/secrets/:id", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  await db
    .delete(userSecretsTable)
    .where(and(eq(userSecretsTable.id, id), eq(userSecretsTable.userId, userId)));

  res.status(204).end();
});

// ── POST /projects/:id/env/from-secret/:secretId — inject into project env ───
router.post(
  "/projects/:id/env/from-secret/:secretId",
  requireAuth,
  async (req, res): Promise<void> => {
    const { userId } = getUser(req);

    const rawProjectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const rawSecretId = Array.isArray(req.params.secretId) ? req.params.secretId[0] : req.params.secretId;
    const projectId = parseInt(rawProjectId, 10);
    const secretId = parseInt(rawSecretId, 10);
    if (isNaN(projectId) || isNaN(secretId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    // Verify project ownership
    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
      .limit(1);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // Fetch and decrypt the vault secret
    const [secret] = await db
      .select({ name: userSecretsTable.name, encryptedValue: userSecretsTable.encryptedValue })
      .from(userSecretsTable)
      .where(and(eq(userSecretsTable.id, secretId), eq(userSecretsTable.userId, userId)))
      .limit(1);
    if (!secret) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const plainValue = decrypt(secret.encryptedValue);

    // Allow caller to override the env var name (defaults to secret name)
    const overrideName = req.body?.overrideName;
    const envKey = typeof overrideName === "string" && isValidEnvKey(overrideName)
      ? overrideName
      : secret.name;

    const encryptedValue = encrypt(plainValue);

    await db
      .insert(projectEnvVarsTable)
      .values({ projectId, key: envKey, encryptedValue })
      .onConflictDoUpdate({
        target: [projectEnvVarsTable.projectId, projectEnvVarsTable.key],
        set: { encryptedValue, updatedAt: new Date() },
      });

    res.status(204).end();
  },
);

export default router;
