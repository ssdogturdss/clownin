import { Router, type IRouter } from "express";
import { db, projectsTable, projectFilesTable, usersTable, conversationMessagesTable } from "@workspace/db";
import { eq, and, count, sql, asc } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { randomBytes } from "crypto";
import { findTemplate } from "../data/templates";

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
  const { name, language: rawLanguage, description, templateId } = req.body ?? {};

  // If a templateId is provided, use the template's language as the default
  const template = templateId ? findTemplate(String(templateId)) : undefined;
  const language = rawLanguage ?? template?.language ?? "javascript";

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

  // Populate files: from template if provided, otherwise from the default single file
  if (template) {
    await db.insert(projectFilesTable).values(
      template.files.map((f) => ({
        projectId: project.id,
        path: f.path,
        content: f.content,
        // Infer per-file language from extension; fall back to the project language
        language: inferLanguage(f.path) ?? language,
      }))
    );
  } else {
    const mainFile = getDefaultFile(language);
    await db.insert(projectFilesTable).values({
      projectId: project.id,
      path: mainFile.path,
      content: mainFile.content,
      language,
    });
  }

  req.log.info({ projectId: project.id, templateId: template?.id ?? null }, "Project created");
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

  const { name, description, serverId } = req.body ?? {};
  const updates: Partial<{ name: string; description: string; serverId: number | null }> = {};
  if (name != null) updates.name = name;
  if (description != null) updates.description = description;
  // serverId: explicit null clears it, a number sets it, undefined leaves it unchanged
  if (serverId !== undefined) updates.serverId = serverId === null ? null : Number(serverId);

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

/** Map a file extension to its language identifier. Returns undefined for unknown extensions. */
function inferLanguage(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    sh: "bash",
    go: "go",
    rs: "rust",
    rb: "ruby",
    java: "java",
    html: "plaintext",
    css: "plaintext",
    json: "plaintext",
    md: "plaintext",
    txt: "plaintext",
  };
  return ext ? map[ext] : undefined;
}

function getDefaultFile(language: string): { path: string; content: string } {
  switch (language) {
    case "python":
      return { path: "main.py", content: 'print("Hello, Clownin! 🤡")\n' };
    case "typescript":
      return { path: "index.ts", content: 'console.log("Hello, Clownin! 🤡");\n' };
    case "bash":
      return { path: "main.sh", content: '#!/usr/bin/env bash\necho "Hello, Clownin! 🤡"\n' };
    case "go":
      return {
        path: "main.go",
        content: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello, Clownin! 🤡")\n}\n',
      };
    case "rust":
      return {
        path: "main.rs",
        content: 'fn main() {\n    println!("Hello, Clownin! 🤡");\n}\n',
      };
    case "ruby":
      return {
        path: "main.rb",
        content: 'puts "Hello, Clownin! 🤡"\n',
      };
    case "java":
      return {
        path: "Main.java",
        content: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, Clownin! 🤡");\n    }\n}\n',
      };
    case "javascript":
    default:
      return { path: "index.js", content: 'console.log("Hello, Clownin! 🤡");\n' };
  }
}

// ── Conversation history ─────────────────────────────────────────────────────

router.get(
  "/projects/:id/conversations",
  requireAuth,
  async (req, res): Promise<void> => {
    const { userId } = getUser(req);
    const projectId = parseInt(req.params["id"] as string, 10);
    if (isNaN(projectId)) { res.status(400).json({ error: "invalid project id" }); return; }

    // Verify ownership
    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
      .limit(1);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }

    const messages = await db
      .select()
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.projectId, projectId))
      .orderBy(asc(conversationMessagesTable.createdAt))
      .limit(100);

    res.json(messages);
  },
);

router.delete(
  "/projects/:id/conversations",
  requireAuth,
  async (req, res): Promise<void> => {
    const { userId } = getUser(req);
    const projectId = parseInt(req.params["id"] as string, 10);
    if (isNaN(projectId)) { res.status(400).json({ error: "invalid project id" }); return; }

    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
      .limit(1);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }

    await db
      .delete(conversationMessagesTable)
      .where(eq(conversationMessagesTable.projectId, projectId));

    res.json({ ok: true });
  },
);

export default router;
