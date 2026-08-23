import { Router, type IRouter } from "express";
import { db, projectsTable, projectFilesTable, usersTable, conversationMessagesTable, conversationSessionsTable, projectEnvVarsTable, agentRunSnapshotsTable } from "@workspace/db";
import { eq, and, count, sql, asc, desc, isNotNull, isNull, inArray } from "drizzle-orm";
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

  // Delete child rows first to avoid FK violations
  await db.delete(conversationMessagesTable).where(eq(conversationMessagesTable.projectId, id));
  await db.delete(projectEnvVarsTable).where(eq(projectEnvVarsTable.projectId, id));
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

// Returns a list of sessions (grouped by session_id) for a project.
// Each entry has: sessionId, preview, messageCount, startedAt, lastAt.
// Ordered by most-recent session first.
router.get(
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

    // Aggregate per session: count, earliest & latest timestamps, first user message preview
    const sessions = await db.execute<{
      session_id: string | null;
      message_count: string;
      started_at: Date;
      last_at: Date;
    }>(sql`
      SELECT
        session_id,
        COUNT(*) AS message_count,
        MIN(created_at) AS started_at,
        MAX(created_at) AS last_at
      FROM conversation_messages
      WHERE project_id = ${projectId}
      GROUP BY session_id
      ORDER BY MAX(created_at) DESC
    `);

    // Fetch session names in one query for all session ids
    const sessionIds = sessions.rows
      .map((r) => r.session_id)
      .filter((id): id is string => id !== null);

    // Scope by both session_id AND project_id so that if a session_id somehow
    // appears in conversation_sessions for a different project, it cannot bleed
    // its name into this project's sessions list.
    const nameRows = sessionIds.length
      ? await db
          .select({ sessionId: conversationSessionsTable.sessionId, name: conversationSessionsTable.name })
          .from(conversationSessionsTable)
          .where(and(
            inArray(conversationSessionsTable.sessionId, sessionIds),
            eq(conversationSessionsTable.projectId, projectId),
          ))
      : [];
    const nameMap = new Map(nameRows.map((r) => [r.sessionId, r.name]));

    // For each session, fetch the first user message as a preview (separate query,
    // avoids correlated subquery complexities across drivers).
    const result: Array<{
      sessionId: string | null;
      name: string | null;
      preview: string;
      messageCount: number;
      startedAt: string;
      lastAt: string;
    }> = [];

    for (const row of sessions.rows) {
      const [previewRow] = await db
        .select({ content: conversationMessagesTable.content })
        .from(conversationMessagesTable)
        .where(
          and(
            eq(conversationMessagesTable.projectId, projectId),
            row.session_id
              ? eq(conversationMessagesTable.sessionId, row.session_id)
              : sql`session_id IS NULL`,
            eq(conversationMessagesTable.role, "user"),
          )
        )
        .orderBy(asc(conversationMessagesTable.createdAt))
        .limit(1);

      result.push({
        sessionId: row.session_id,
        name: row.session_id ? (nameMap.get(row.session_id) ?? null) : null,
        preview: previewRow ? previewRow.content.slice(0, 120) : "",
        messageCount: Number(row.message_count),
        startedAt: new Date(row.started_at).toISOString(),
        lastAt: new Date(row.last_at).toISOString(),
      });
    }

    res.json(result);
  },
);

// Returns all messages for a specific session.
// Use the sentinel value "legacy" as the sessionId to retrieve messages where
// session_id IS NULL (i.e. messages created before the session_id migration).
router.get(
  "/projects/:id/conversations/:sessionId",
  requireAuth,
  async (req, res): Promise<void> => {
    const { userId } = getUser(req);
    const projectId = parseInt(req.params["id"] as string, 10);
    if (isNaN(projectId)) { res.status(400).json({ error: "invalid project id" }); return; }
    const sessionId = req.params["sessionId"] as string;

    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
      .limit(1);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }

    // "legacy" is the sentinel for pre-migration rows where session_id IS NULL
    const sessionFilter =
      sessionId === "legacy"
        ? isNull(conversationMessagesTable.sessionId)
        : eq(conversationMessagesTable.sessionId, sessionId);

    const messages = await db
      .select()
      .from(conversationMessagesTable)
      .where(and(eq(conversationMessagesTable.projectId, projectId), sessionFilter))
      .orderBy(asc(conversationMessagesTable.createdAt))
      .limit(200);

    res.json(messages);
  },
);

// Deletes all messages for a specific session.
// Use the sentinel value "legacy" as the sessionId to delete messages where
// session_id IS NULL (i.e. messages created before the session_id migration).
router.delete(
  "/projects/:id/conversations/:sessionId",
  requireAuth,
  async (req, res): Promise<void> => {
    const { userId } = getUser(req);
    const projectId = parseInt(req.params["id"] as string, 10);
    if (isNaN(projectId)) { res.status(400).json({ error: "invalid project id" }); return; }
    const sessionId = req.params["sessionId"] as string;

    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
      .limit(1);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }

    // "legacy" is the sentinel for pre-migration rows where session_id IS NULL
    const sessionFilter =
      sessionId === "legacy"
        ? isNull(conversationMessagesTable.sessionId)
        : eq(conversationMessagesTable.sessionId, sessionId);

    await db
      .delete(conversationMessagesTable)
      .where(and(eq(conversationMessagesTable.projectId, projectId), sessionFilter));

    // Also remove the conversation_sessions row so the session name cannot
    // reappear if a new session is later created with the same session_id.
    // "legacy" sessions have no session_id and therefore no sessions row.
    if (sessionId !== "legacy") {
      await db
        .delete(conversationSessionsTable)
        .where(
          and(
            eq(conversationSessionsTable.sessionId, sessionId),
            eq(conversationSessionsTable.projectId, projectId),
          ),
        );
    }

    res.json({ ok: true });
  },
);

// Rename a session.
router.patch(
  "/projects/:id/conversations/:sessionId/name",
  requireAuth,
  async (req, res): Promise<void> => {
    const { userId } = getUser(req);
    const projectId = parseInt(req.params["id"] as string, 10);
    if (isNaN(projectId)) { res.status(400).json({ error: "invalid project id" }); return; }
    const sessionId = req.params["sessionId"] as string;
    const { name } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    // Verify the caller owns the project
    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
      .limit(1);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }

    // Verify the session actually belongs to this project (prevents IDOR: a
    // caller supplying a foreign session_id would find no matching message row).
    const [sessionCheck] = await db
      .select({ sessionId: conversationMessagesTable.sessionId })
      .from(conversationMessagesTable)
      .where(
        and(
          eq(conversationMessagesTable.projectId, projectId),
          eq(conversationMessagesTable.sessionId, sessionId),
        )
      )
      .limit(1);
    if (!sessionCheck) { res.status(404).json({ error: "session not found" }); return; }

    // Upsert — the session is confirmed to belong to this project
    await db
      .insert(conversationSessionsTable)
      .values({ sessionId, projectId, name: name.trim() })
      .onConflictDoUpdate({
        target: conversationSessionsTable.sessionId,
        set: { name: name.trim() },
      });

    res.json({ ok: true, name: name.trim() });
  },
);

// Deletes ALL conversations for a project (across all sessions).
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

// ── Agent run history & restore ────────────────────────────────────────────────

/** List recent agent runs for a project (newest first, up to 30). */
router.get(
  "/projects/:id/runs",
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

    const runs = await db
      .select({
        runId: agentRunSnapshotsTable.runId,
        sessionId: agentRunSnapshotsTable.sessionId,
        changedPaths: agentRunSnapshotsTable.changedPaths,
        createdPaths: agentRunSnapshotsTable.createdPaths,
        deletedPaths: agentRunSnapshotsTable.deletedPaths,
        renamedPaths: agentRunSnapshotsTable.renamedPaths,
        createdAt: agentRunSnapshotsTable.createdAt,
      })
      .from(agentRunSnapshotsTable)
      .where(eq(agentRunSnapshotsTable.projectId, projectId))
      .orderBy(desc(agentRunSnapshotsTable.createdAt))
      .limit(30);

    res.json(
      runs.map((r) => ({
        runId: r.runId,
        sessionId: r.sessionId,
        createdAt: r.createdAt,
        changedFiles: {
          modified: JSON.parse(r.changedPaths) as string[],
          created:  JSON.parse(r.createdPaths) as string[],
          deleted:  JSON.parse(r.deletedPaths) as string[],
          renamed:  JSON.parse(r.renamedPaths) as Array<{ from: string; to: string }>,
        },
      }))
    );
  },
);

/** Return a before/after diff for a specific agent run. */
router.get(
  "/projects/:id/runs/:runId/diff",
  requireAuth,
  async (req, res): Promise<void> => {
    const { userId } = getUser(req);
    const projectId = parseInt(req.params["id"] as string, 10);
    const { runId } = req.params as { runId: string };
    if (isNaN(projectId)) { res.status(400).json({ error: "invalid project id" }); return; }

    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
      .limit(1);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }

    const [snapshot] = await db
      .select()
      .from(agentRunSnapshotsTable)
      .where(and(eq(agentRunSnapshotsTable.runId, runId), eq(agentRunSnapshotsTable.projectId, projectId)))
      .limit(1);
    if (!snapshot) { res.status(404).json({ error: "run not found" }); return; }

    const changedPaths: string[] = JSON.parse(snapshot.changedPaths);
    const createdPaths: string[] = JSON.parse(snapshot.createdPaths);
    const deletedPaths: string[] = JSON.parse(snapshot.deletedPaths);
    const renamedPaths: Array<{ from: string; to: string }> = JSON.parse(snapshot.renamedPaths);

    // fileSnapshots stores {before, after} per path (new format) or string|null (legacy = before only).
    // Use getSnapshotState() so both formats work.
    type FileMutationState = { before: string | null; after: string | null };
    const rawSnapshots: Record<string, FileMutationState | string | null> = JSON.parse(snapshot.fileSnapshots);
    function getSnapshotState(path: string): FileMutationState {
      const raw = rawSnapshots[path];
      if (raw !== null && typeof raw === "object") return raw as FileMutationState;
      // Legacy: value is just the "before" string (or null = agent created)
      return { before: raw as string | null, after: null };
    }

    type ChangeEntry = {
      path: string;
      type: "modified" | "created" | "deleted" | "renamed_from" | "renamed_to";
      contentBefore: string | null;
      contentAfter:  string | null;
    };

    const changes: ChangeEntry[] = [];

    for (const path of changedPaths) {
      const state = getSnapshotState(path);
      changes.push({ path, type: "modified", contentBefore: state.before, contentAfter: state.after });
    }
    for (const path of createdPaths) {
      const state = getSnapshotState(path);
      changes.push({ path, type: "created", contentBefore: null, contentAfter: state.after });
    }
    for (const path of deletedPaths) {
      const state = getSnapshotState(path);
      changes.push({ path, type: "deleted", contentBefore: state.before, contentAfter: null });
    }
    for (const { from, to } of renamedPaths) {
      const fromState = getSnapshotState(from);
      const toState   = getSnapshotState(to);
      changes.push({ path: from, type: "renamed_from", contentBefore: fromState.before, contentAfter: null });
      changes.push({ path: to,   type: "renamed_to",   contentBefore: null,             contentAfter: toState.after });
    }

    res.json({
      runId: snapshot.runId,
      projectId: snapshot.projectId,
      sessionId: snapshot.sessionId,
      createdAt: snapshot.createdAt,
      changes,
    });
  },
);

/**
 * Restore project files to their state before a specific agent run.
 *
 * Body: { paths?: string[], force?: boolean }
 *   - paths: optional subset of paths to restore; omit to restore all
 *   - force: if true, overwrite even files that have been edited after the run
 *
 * Returns:
 *   { ok: true, restored: string[] }          on success
 *   { requiresConfirm: true, newerFiles: string[] }  when user edits would be lost
 */
router.post(
  "/projects/:id/runs/:runId/restore",
  requireAuth,
  async (req, res): Promise<void> => {
    const { userId } = getUser(req);
    const projectId = parseInt(req.params["id"] as string, 10);
    const { runId } = req.params as { runId: string };
    if (isNaN(projectId)) { res.status(400).json({ error: "invalid project id" }); return; }

    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
      .limit(1);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }

    const [snapshot] = await db
      .select()
      .from(agentRunSnapshotsTable)
      .where(and(eq(agentRunSnapshotsTable.runId, runId), eq(agentRunSnapshotsTable.projectId, projectId)))
      .limit(1);
    if (!snapshot) { res.status(404).json({ error: "run not found" }); return; }

    // Reject incomplete snapshots — completedAt is set in the agent's finally block
    // after all mutations are done; without it we may restore a partial run.
    if (!snapshot.completedAt) {
      res.status(409).json({ error: "run not yet finalized — try again in a moment" });
      return;
    }

    const { paths: requestedPaths, force = false } = (req.body ?? {}) as {
      paths?: string[];
      force?: boolean;
    };

    // fileSnapshots stores {before, after} per path (new format) or string|null (legacy = before only).
    type FileMutationState = { before: string | null; after: string | null };
    const rawSnapshots: Record<string, FileMutationState | string | null> = JSON.parse(snapshot.fileSnapshots);
    function getContentBefore(path: string): string | null | undefined {
      const raw = rawSnapshots[path];
      if (raw === undefined) return undefined;
      if (raw !== null && typeof raw === "object") return (raw as FileMutationState).before;
      return raw as string | null; // legacy: value IS the before content
    }

    // All tracked paths are in rawSnapshots — rename "to" paths are included in new format
    let pathsToRestore = Object.keys(rawSnapshots);

    if (requestedPaths && requestedPaths.length > 0) {
      const requested = new Set(requestedPaths);
      pathsToRestore = pathsToRestore.filter((p) => requested.has(p));
    }

    if (pathsToRestore.length === 0) {
      res.json({ ok: true, restored: [] });
      return;
    }

    // Fetch current state of all paths we might touch
    const currentFiles = await db
      .select({ path: projectFilesTable.path, content: projectFilesTable.content, updatedAt: projectFilesTable.updatedAt, id: projectFilesTable.id, language: projectFilesTable.language })
      .from(projectFilesTable)
      .where(and(eq(projectFilesTable.projectId, projectId), inArray(projectFilesTable.path, pathsToRestore)));
    const currentMap = new Map(currentFiles.map((f) => [f.path, f]));

    // Safety check: find files the user edited AFTER the agent finished.
    // We compare against completedAt (set in the agent's finally block after all
    // mutations are done), not createdAt (set before mutations begin). Files the
    // agent itself wrote will have updatedAt <= completedAt, so they won't
    // trigger a false positive.
    if (!force) {
      const baseline = snapshot.completedAt ?? snapshot.createdAt;
      const newerFiles: string[] = [];
      for (const path of pathsToRestore) {
        const current = currentMap.get(path);
        if (current && current.updatedAt > baseline) {
          newerFiles.push(path);
        }
      }
      if (newerFiles.length > 0) {
        res.json({ requiresConfirm: true, newerFiles });
        return;
      }
    }

    // Perform restore operations
    const restored: string[] = [];
    for (const path of pathsToRestore) {
      const contentBefore = getContentBefore(path);
      const current = currentMap.get(path);

      if (contentBefore === undefined) {
        // Path not in snapshot — skip (shouldn't happen with Object.keys)
        continue;
      } else if (contentBefore === null) {
        // File was created (or rename-placed) by the agent — delete it
        if (current) {
          await db.delete(projectFilesTable).where(eq(projectFilesTable.id, current.id));
          restored.push(path);
        }
      } else {
        // File existed before — restore its original content
        if (current) {
          await db.update(projectFilesTable)
            .set({ content: contentBefore, updatedAt: new Date() })
            .where(eq(projectFilesTable.id, current.id));
        } else {
          // File was deleted by the agent — recreate it
          await db.insert(projectFilesTable).values({
            projectId,
            path,
            content: contentBefore,
            language: "plaintext",
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        restored.push(path);
      }
    }

    res.json({ ok: true, restored });
  },
);

export default router;
