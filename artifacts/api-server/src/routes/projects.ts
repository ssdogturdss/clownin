import { Router, type IRouter } from "express";
import { db, projectsTable, projectFilesTable, usersTable } from "@workspace/db";
import { eq, and, count, sql } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { randomBytes } from "crypto";

const router: IRouter = Router();

router.get("/projects", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const projects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.userId, userId))
    .orderBy(projectsTable.updatedAt);

  res.json(projects);
});

router.post("/projects", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const { name, language = "javascript", description } = req.body ?? {};

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  // ── Subscription: project count limit for free tier (atomic) ────────────
  const [currentUser] = await db
    .select({ subscriptionTier: usersTable.subscriptionTier })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  // For free-tier users, count + insert happen inside a single transaction
  // protected by a per-user advisory lock so concurrent requests cannot
  // both pass the limit check and both successfully insert.
  let project: typeof projectsTable.$inferSelect;

  if (currentUser?.subscriptionTier === "free") {
    const txResult = await db.transaction(async (tx) => {
      // pg_advisory_xact_lock serializes all transactions for this user_id.
      // The lock is automatically released when the transaction ends.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId})`);

      const [{ value: projectCount }] = await tx
        .select({ value: count() })
        .from(projectsTable)
        .where(eq(projectsTable.userId, userId));

      if (projectCount >= 3) {
        return { limitExceeded: true as const, count: projectCount };
      }

      const [p] = await tx
        .insert(projectsTable)
        .values({ userId, name, language, description: description ?? null })
        .returning();

      return { limitExceeded: false as const, project: p };
    });

    if (txResult.limitExceeded) {
      res.status(402).json({
        error: "Project limit reached",
        code: "project_limit_exceeded",
        limit: 3,
        tier: "free",
      });
      return;
    }

    project = txResult.project!;
  } else {
    // Pro users (or unrecognised tier) — insert directly
    const [p] = await db
      .insert(projectsTable)
      .values({ userId, name, language, description: description ?? null })
      .returning();
    project = p;
  }
  // ── End subscription enforcement ─────────────────────────────────────────

  // Create a default main file based on language
  const mainFile = getDefaultFile(language);
  await db.insert(projectFilesTable).values({
    projectId: project.id,
    path: mainFile.path,
    content: mainFile.content,
    language,
  });

  req.log.info({ projectId: project.id }, "Project created");
  res.status(201).json(project);
});

router.get("/projects/:id", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, id), eq(projectsTable.userId, userId)))
    .limit(1);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const files = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, id))
    .orderBy(projectFilesTable.path);

  res.json({ ...project, files });
});

router.patch("/projects/:id", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const existing = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, id), eq(projectsTable.userId, userId)))
    .limit(1);

  if (existing.length === 0) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { name, description } = req.body ?? {};
  const updates: Partial<{ name: string; description: string }> = {};
  if (name != null) updates.name = name;
  if (description != null) updates.description = description;

  const [updated] = await db
    .update(projectsTable)
    .set(updates)
    .where(eq(projectsTable.id, id))
    .returning();

  res.json(updated);
});

router.delete("/projects/:id", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const existing = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, id), eq(projectsTable.userId, userId)))
    .limit(1);

  if (existing.length === 0) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Delete files first
  await db.delete(projectFilesTable).where(eq(projectFilesTable.projectId, id));
  await db.delete(projectsTable).where(eq(projectsTable.id, id));

  req.log.info({ projectId: id }, "Project deleted");
  res.sendStatus(204);
});

// ─── Preview enable ───────────────────────────────────────────────────────────

router.post("/projects/:id/preview/enable", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, id), eq(projectsTable.userId, userId)))
    .limit(1);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Reuse existing shortId or generate a new one (idempotent).
  // Retry up to 5 times in the unlikely event of a unique-index collision.
  let shortId = project.previewShortId;
  let updated: typeof projectsTable.$inferSelect | undefined;
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidateId = shortId ?? randomBytes(5).toString("hex"); // 10 hex chars
    try {
      [updated] = await db
        .update(projectsTable)
        .set({ previewEnabled: true, previewShortId: candidateId })
        .where(eq(projectsTable.id, id))
        .returning();
      shortId = candidateId;
      break;
    } catch (err: unknown) {
      // Unique constraint violation on preview_short_id — retry with a new ID
      const pgErr = err as { code?: string };
      if (pgErr?.code === "23505" && attempt < maxAttempts - 1) {
        shortId = null; // force generation of a new candidate
        continue;
      }
      throw err;
    }
  }

  if (!updated) {
    res.status(500).json({ error: "Failed to enable preview" });
    return;
  }

  req.log.info({ projectId: id, shortId }, "Preview enabled");
  res.json({ shortId: updated.previewShortId, previewEnabled: updated.previewEnabled });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDefaultFile(language: string): { path: string; content: string } {
  switch (language) {
    case "python":
      return { path: "main.py", content: 'print("Hello, Clownin! 🤡")\n' };
    case "typescript":
      return { path: "index.ts", content: 'console.log("Hello, Clownin! 🤡");\n' };
    case "bash":
      return { path: "main.sh", content: '#!/usr/bin/env bash\necho "Hello, Clownin! 🤡"\n' };
    case "javascript":
    default:
      return { path: "index.js", content: 'console.log("Hello, Clownin! 🤡");\n' };
  }
}

export default router;
