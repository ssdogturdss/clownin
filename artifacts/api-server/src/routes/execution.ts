import { Router, type IRouter } from "express";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { db, projectsTable, projectFilesTable, serversTable, projectEnvVarsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import {
  syncProjectFiles,
  runInstallIfNeeded,
  cleanProjectPackages,
  projectDir,
  hasDepManifest,
} from "../lib/projectWorkspace";
import { streamRemoteProcess, cleanRemotePackages } from "../lib/sshExecution";
import { decrypt, filterUserEnv } from "../lib/envCrypto";

const router: IRouter = Router();

const EXECUTION_TIMEOUT_MS = 10_000;

// ── Active run registry ────────────────────────────────────────────────────────
// Maps run token → registered run entry. The token is sent to the client only
// AFTER the process is registered here, so there is no window where the client
// holds a token but stdin would be dropped silently.
//
// NOTE: this map lives in process memory only. A server restart clears it.
// In-flight runs during a restart will have their tokens rejected with 410.
type ActiveRun = {
  projectId: number;
  userId: number;
  /** Write data to the process stdin. Returns false when stdin is unavailable
   *  (process closed fd 0, broken pipe, or stream errored). */
  writeStdin: (data: string) => boolean;
};
const activeRuns = new Map<string, ActiveRun>();

// ── Language → executor ────────────────────────────────────────────────────────
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

// ── Execute ────────────────────────────────────────────────────────────────────
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

  // Get all project files (needed for both local sync and SSH upload)
  const allFiles = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  // Load and decrypt the project's env vars. We decrypt here (server-side only)
  // and never return raw values to the client.
  const envVarRows = await db
    .select({ key: projectEnvVarsTable.key, encryptedValue: projectEnvVarsTable.encryptedValue })
    .from(projectEnvVarsTable)
    .where(eq(projectEnvVarsTable.projectId, projectId));

  const userEnv: Record<string, string> = {};
  for (const v of envVarRows) {
    try { userEnv[v.key] = decrypt(v.encryptedValue); } catch { /* skip corrupted */ }
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  function sendEvent(type: "token" | "stdout" | "stderr" | "exit" | "system", payload: string) {
    const data = JSON.stringify({ type, payload });
    res.write(`data: ${data}\n\n`);
  }

  req.log.info({ projectId, fileId: file.id, language: file.language }, "Executing code");

  // Stable token for this run — sent to the client only AFTER the process
  // is registered in activeRuns (see each path below).
  const runToken = randomUUID();

  // ── SSH execution path ─────────────────────────────────────────────────────
  if (project.serverId) {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(and(eq(serversTable.id, project.serverId), eq(serversTable.userId, userId)))
      .limit(1);

    if (!server) {
      sendEvent("stderr", "[Custom server not found — run your project locally or reconfigure it]");
      sendEvent("exit", "-1");
      res.end();
      return;
    }

    const abortSignal = { aborted: false };
    req.on("close", () => {
      abortSignal.aborted = true;
      activeRuns.delete(runToken);
    });

    streamRemoteProcess(
      { host: server.host, port: server.port, username: server.username, password: server.password, privateKey: server.privateKey },
      projectId,
      allFiles,
      file.path,
      file.language,
      {
        // onStreamReady fires only after the SSH exec channel is open and
        // ready to receive input — register THEN emit the token so the
        // client cannot send stdin before the channel exists.
        onStreamReady: (writeStdin) => {
          activeRuns.set(runToken, { projectId, userId, writeStdin });
          sendEvent("token", runToken);
        },
        onSystem: (chunk) => sendEvent("system", chunk),
        onStdout: (chunk) => sendEvent("stdout", chunk),
        onStderr: (chunk) => sendEvent("stderr", chunk),
        onExit: (code) => {
          activeRuns.delete(runToken);
          sendEvent("exit", String(code));
          res.end();
        },
        onError: (msg) => {
          activeRuns.delete(runToken);
          sendEvent("stderr", `\n[SSH error: ${msg}]`);
          sendEvent("exit", "-1");
          res.end();
        },
      },
      abortSignal,
      filterUserEnv(userEnv)   // strip reserved keys (PATH, PORT, etc.) so remote shell is not broken
    );
    return;
  }

  // ── Local execution path ───────────────────────────────────────────────────
  let localProjDir: string;
  try {
    localProjDir = await syncProjectFiles(projectId, allFiles);
  } catch (err) {
    req.log.error({ err }, "Failed to sync project files");
    res.status(500).json({ error: "Failed to prepare execution" });
    return;
  }

  // Run npm install / pip install if the manifest has changed or packages are absent.
  // Output streams as "system" events so the terminal shows it in grey/italic.
  await runInstallIfNeeded(localProjDir, allFiles, (type, text) => sendEvent(type, text));

  const absFilePath = join(localProjDir, file.path);
  let { cmd, args } = getExecutorCommand(file.language, absFilePath)!;

  // For Python projects: prefer the project-local venv interpreter so that
  // packages installed by pip install -r requirements.txt are available.
  const { hasPip } = hasDepManifest(allFiles);
  if (hasPip && ["python", "python3", "py"].includes(file.language)) {
    const venvPython = join(localProjDir, ".venv", "bin", "python3");
    if (existsSync(venvPython)) {
      cmd = venvPython;
      args = [absFilePath];
    }
  }

  // Strict allowlist — never pass server secrets (DATABASE_URL, JWT_SECRET, etc.)
  // to untrusted user code. Only provide what the runtime needs to find binaries.
  // User-defined env vars are merged first so that system vars always win.
  const safeEnv: NodeJS.ProcessEnv = {
    // User-supplied env vars filtered of reserved keys, then system vars override
    ...filterUserEnv(userEnv),
    // System vars always override to prevent PATH hijacking etc.
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG,
    // Python needs these to locate the stdlib
    PYTHONPATH: undefined,
    PYTHONHOME: undefined,
  };

  // stdio: 'pipe' keeps stdin open so we can write to it after the process starts.
  const child = spawn(cmd, args, {
    env: safeEnv,
    cwd: localProjDir,
    stdio: "pipe",
  });

  // Track whether stdin is still writable. The error listener MUST be attached
  // before any write can happen (i.e. before the token is emitted) so there is
  // no window where an EPIPE event could go unhandled and crash the process.
  let stdinOpen = true;
  child.stdin?.on("error", () => {
    // EPIPE or other stdin errors — mark unavailable and evict from registry
    // so subsequent /stdin requests receive 410 rather than 204.
    stdinOpen = false;
    activeRuns.delete(runToken);
  });

  // Register BEFORE emitting the token so the client can never reach /stdin
  // before the entry exists.
  activeRuns.set(runToken, {
    projectId,
    userId,
    writeStdin: (data: string): boolean => {
      if (!stdinOpen || !child.stdin?.writable) return false;
      try {
        child.stdin.write(data);
        return true;
      } catch {
        stdinOpen = false;
        return false;
      }
    },
  });
  sendEvent("token", runToken);

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
    activeRuns.delete(runToken);
    sendEvent("exit", String(code ?? -1));
    res.end();
  });

  child.on("error", (err) => {
    clearTimeout(timeout);
    activeRuns.delete(runToken);
    req.log.error({ err }, "Execution process error");
    sendEvent("stderr", `\n[Execution error: ${err.message}]`);
    sendEvent("exit", "-1");
    res.end();
  });

  // Handle client disconnect
  req.on("close", () => {
    clearTimeout(timeout);
    activeRuns.delete(runToken);
    child.kill();
  });
});

// ── Clean install ──────────────────────────────────────────────────────────────
// Wipe node_modules / .venv from the local workspace (and the remote SSH machine
// for SSH-linked projects) so the next run reinstalls packages from scratch.
router.post("/projects/:id/clean", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const projectId = parseInt(rawId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId))).limit(1);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  // Always wipe local workspace (idempotent if workspace doesn't exist yet)
  await cleanProjectPackages(projectDir(projectId));

  // For SSH-linked projects, also clean on the remote machine (best-effort)
  if (project.serverId) {
    const [server] = await db.select().from(serversTable)
      .where(and(eq(serversTable.id, project.serverId), eq(serversTable.userId, userId))).limit(1);
    if (server) {
      await cleanRemotePackages(
        { host: server.host, port: server.port, username: server.username, password: server.password, privateKey: server.privateKey },
        projectId,
      ).catch(() => {}); // best-effort — don't fail if SSH is unreachable
    }
  }

  res.json({ ok: true });
});

// ── Stdin ──────────────────────────────────────────────────────────────────────
// Write a line of input to an active run's stdin.
// Body: { token: string, data: string }
// Returns 204 on success, 410 Gone when the run has ended/never existed.
router.post("/projects/:id/stdin", requireAuth, (req, res): void => {
  const { userId } = getUser(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const projectId = parseInt(rawId, 10);

  const { token, data } = req.body ?? {};
  if (!token || typeof data !== "string") {
    res.status(400).json({ error: "token and data are required" });
    return;
  }

  const run = activeRuns.get(token);
  if (!run) {
    // 410 Gone — run has ended or the token is from a server restart.
    // Client should clear the token and disable the stdin input.
    res.status(410).json({ error: "Run has ended" });
    return;
  }

  // Ownership check: the token must belong to this project and this user.
  if (run.projectId !== projectId || run.userId !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Append newline so programs that read line-by-line (input(), readline) get a full line.
  // writeStdin returns false when stdin is unavailable (EPIPE, closed fd 0, SSH error).
  const accepted = run.writeStdin(data.endsWith("\n") ? data : data + "\n");
  if (!accepted) {
    // Stdin is no longer available — evict and tell the client to stop sending.
    activeRuns.delete(token);
    res.status(410).json({ error: "Process stdin is no longer available" });
    return;
  }
  res.status(204).end();
});

export default router;
