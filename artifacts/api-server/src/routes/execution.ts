import { Router, type IRouter } from "express";
import { spawn } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { db, projectsTable, projectFilesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { syncProjectFiles } from "../lib/projectWorkspace";

const router: IRouter = Router();

const EXECUTION_TIMEOUT_MS = 10_000;

function getExecutorCommand(language: string, filePath: string): { cmd: string; args: string[] } | null {
  switch (language) {
    case "javascript":
    case "js":
      return { cmd: "node", args: [filePath] };
    case "typescript":
    case "ts":
      // bun runs TypeScript natively — faster than npx tsx
      return { cmd: "bun", args: ["run", filePath] };
    case "python":
    case "python3":
    case "py":
      return { cmd: "python3", args: [filePath] };
    case "bash":
    case "sh":
      return { cmd: "bash", args: [filePath] };
    default:
      return null;
  }
}

router.post("/projects/:id/execute", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const projectId = parseInt(rawId, 10);

  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const { fileId } = req.body ?? {};
  if (!fileId) {
    res.status(400).json({ error: "fileId is required" });
    return;
  }

  // Verify project ownership
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
    .limit(1);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Get the file
  const [file] = await db
    .select()
    .from(projectFilesTable)
    .where(and(eq(projectFilesTable.id, fileId), eq(projectFilesTable.projectId, projectId)))
    .limit(1);

  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const executor = getExecutorCommand(file.language, "");
  if (!executor) {
    res.status(400).json({ error: `Unsupported language: ${file.language}` });
    return;
  }

  // Sync ALL project files to the per-project workspace so multi-file
  // imports and installed node_modules work correctly.
  const allFiles = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  let projDir: string;
  try {
    projDir = await syncProjectFiles(projectId, allFiles);
  } catch (err) {
    req.log.error({ err }, "Failed to sync project files");
    res.status(500).json({ error: "Failed to prepare execution" });
    return;
  }

  const absFilePath = join(projDir, file.path);

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  function sendEvent(type: "stdout" | "stderr" | "exit", payload: string) {
    const data = JSON.stringify({ type, payload });
    res.write(`data: ${data}\n\n`);
  }

  req.log.info({ projectId, fileId: file.id, language: file.language }, "Executing code");

  const { cmd, args } = getExecutorCommand(file.language, absFilePath)!;

  // Strict allowlist — never pass server secrets (DATABASE_URL, JWT_SECRET, etc.)
  // to untrusted user code. Only provide what the runtime needs to find binaries.
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG,
    // Python needs these to locate the stdlib
    PYTHONPATH: undefined,
    PYTHONHOME: undefined,
  };

  const child = spawn(cmd, args, {
    timeout: EXECUTION_TIMEOUT_MS,
    env: safeEnv,
    cwd: projDir,
  });

  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    sendEvent("stderr", "\n[Execution timed out after 10 seconds]");
  }, EXECUTION_TIMEOUT_MS);

  child.stdout.on("data", (chunk: Buffer) => {
    sendEvent("stdout", chunk.toString("utf8"));
  });

  child.stderr.on("data", (chunk: Buffer) => {
    sendEvent("stderr", chunk.toString("utf8"));
  });

  child.on("close", (code) => {
    clearTimeout(timeout);
    sendEvent("exit", String(code ?? -1));
    res.end();
  });

  child.on("error", (err) => {
    clearTimeout(timeout);
    req.log.error({ err }, "Execution process error");
    sendEvent("stderr", `\n[Execution error: ${err.message}]`);
    sendEvent("exit", "-1");
    res.end();
  });

  // Handle client disconnect
  req.on("close", () => {
    clearTimeout(timeout);
    child.kill();
  });
});

export default router;
