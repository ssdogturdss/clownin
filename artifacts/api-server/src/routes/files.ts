import { Router, type IRouter } from "express";
import { db, projectsTable, projectFilesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";

const router: IRouter = Router();

// Verify project ownership helper
async function verifyProjectOwnership(
  projectId: number,
  userId: number,
): Promise<boolean> {
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
    .limit(1);
  return !!project;
}

router.get("/projects/:id/files", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const projectId = parseInt(raw, 10);

  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const owned = await verifyProjectOwnership(projectId, userId);
  if (!owned) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const files = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId))
    .orderBy(projectFilesTable.path);

  res.json(files);
});

router.post("/projects/:id/files", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const projectId = parseInt(raw, 10);

  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const owned = await verifyProjectOwnership(projectId, userId);
  if (!owned) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { path, content = "", language = "plaintext" } = req.body ?? {};
  if (!path) {
    res.status(400).json({ error: "path is required" });
    return;
  }

  const [file] = await db
    .insert(projectFilesTable)
    .values({ projectId, path, content, language })
    .returning();

  req.log.info({ fileId: file.id, projectId }, "File created");
  res.status(201).json(file);
});

router.get("/projects/:id/files/:fileId", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawFileId = Array.isArray(req.params.fileId) ? req.params.fileId[0] : req.params.fileId;
  const projectId = parseInt(rawId, 10);
  const fileId = parseInt(rawFileId, 10);

  if (isNaN(projectId) || isNaN(fileId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const owned = await verifyProjectOwnership(projectId, userId);
  if (!owned) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [file] = await db
    .select()
    .from(projectFilesTable)
    .where(and(eq(projectFilesTable.id, fileId), eq(projectFilesTable.projectId, projectId)))
    .limit(1);

  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  res.json(file);
});

router.patch("/projects/:id/files/:fileId", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawFileId = Array.isArray(req.params.fileId) ? req.params.fileId[0] : req.params.fileId;
  const projectId = parseInt(rawId, 10);
  const fileId = parseInt(rawFileId, 10);

  if (isNaN(projectId) || isNaN(fileId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const owned = await verifyProjectOwnership(projectId, userId);
  if (!owned) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const existing = await db
    .select()
    .from(projectFilesTable)
    .where(and(eq(projectFilesTable.id, fileId), eq(projectFilesTable.projectId, projectId)))
    .limit(1);

  if (existing.length === 0) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const { content, path, language } = req.body ?? {};
  const updates: Partial<{ content: string; path: string; language: string }> = {};
  if (content != null) updates.content = content;
  if (path != null) updates.path = path;
  if (language != null) updates.language = language;

  const [updated] = await db
    .update(projectFilesTable)
    .set(updates)
    .where(eq(projectFilesTable.id, fileId))
    .returning();

  res.json(updated);
});

router.delete("/projects/:id/files/:fileId", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawFileId = Array.isArray(req.params.fileId) ? req.params.fileId[0] : req.params.fileId;
  const projectId = parseInt(rawId, 10);
  const fileId = parseInt(rawFileId, 10);

  if (isNaN(projectId) || isNaN(fileId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const owned = await verifyProjectOwnership(projectId, userId);
  if (!owned) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [deleted] = await db
    .delete(projectFilesTable)
    .where(and(eq(projectFilesTable.id, fileId), eq(projectFilesTable.projectId, projectId)))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  req.log.info({ fileId, projectId }, "File deleted");
  res.sendStatus(204);
});

export default router;
