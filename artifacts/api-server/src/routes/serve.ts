/**
 * Live web server preview.
 *
 * Two exports:
 *   serveProxyRouter  — unauthenticated reverse proxy, mounted in app.ts BEFORE
 *                       body-parser middleware so raw request bodies are piped intact.
 *   default (router)  — authenticated serve API (start / stop / status / logs).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import { request as httpRequest } from "http";
import { join } from "path";
import { tmpdir } from "os";
import { db, projectsTable, projectFilesTable, serversTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { syncProjectFiles } from "../lib/projectWorkspace";
import {
  startSshServerBackground,
  startSshLogTail,
  startSshTunnel,
  startSshPidMonitor,
  stopSshServerBackground,
  type SshServerConfig,
} from "../lib/sshExecution";

// ── Log fan-out ──────────────────────────────────────────────────────────────
type LogLine = { type: "stdout" | "stderr" | "system"; text: string; ts: number };
const LOG_BUFFER_MAX = 300;

// ── Active server registry ────────────────────────────────────────────────────
// NOTE: lives in process memory only. A server restart clears all entries.
type BaseServer = {
  projectId: number;
  userId: number;
  port: number;
  url: string;
  startedAt: Date;
  logBuffer: LogLine[];
  logListeners: Set<(line: LogLine) => void>;
  stopped: boolean;
  /** Guards against double-exit broadcasts (e.g. when a new server replaces an old one). */
  exitEmitted: boolean;
};
type LocalServer = BaseServer & {
  kind: "local";
  child: ChildProcess;
  /** Set to true in close/error handlers; used to decide whether SIGKILL is needed. */
  childExited: boolean;
};
type SshServer   = BaseServer & {
  kind: "ssh";
  srvConfig: SshServerConfig;
  remotePid: number;
  /** Set after tunnel is established; null until then. */
  killTunnel: (() => void) | null;
  /** Set after PID monitor is established; null until then. */
  killMonitor: (() => void) | null;
  /** Set after log tail is established; null until then. */
  killTail: (() => void) | null;
};
type ActiveServer = LocalServer | SshServer;

const activeServers = new Map<number, ActiveServer>();

function broadcast(entry: ActiveServer, line: LogLine) {
  entry.logBuffer.push(line);
  if (entry.logBuffer.length > LOG_BUFFER_MAX) entry.logBuffer.shift();
  for (const l of entry.logListeners) l(line);
}

/** Idempotent: only broadcasts an exit event once per entry lifecycle. */
function broadcastExit(entry: ActiveServer, code: number | null) {
  if (entry.exitEmitted) return;
  entry.exitEmitted = true;
  const line: LogLine = { type: "system", text: `__SERVE_EXIT__${code ?? -1}`, ts: Date.now() };
  entry.logBuffer.push(line);
  for (const l of entry.logListeners) l(line);
}

/** Remove entry from registry only if it still holds the same instance. */
function evictIfCurrent(entry: ActiveServer) {
  if (activeServers.get(entry.projectId) === entry) {
    activeServers.delete(entry.projectId);
  }
}

// ── Port allocation ───────────────────────────────────────────────────────────
const PORT_MIN = 20_000;
const PORT_MAX = 29_999;

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryPort = () => {
      if (++attempts > 30) { reject(new Error("No free port available")); return; }
      const p = Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1)) + PORT_MIN;
      const probe = createServer();
      probe.listen(p, "127.0.0.1", () => probe.close(() => resolve(p)));
      probe.on("error", tryPort);
    };
    tryPort();
  });
}

// ── URL construction ──────────────────────────────────────────────────────────
function buildProxyUrl(req: Request, projectId: number): string {
  const domain = process.env.REPLIT_DEV_DOMAIN;
  if (domain) return `https://${domain}/api/projects/${projectId}/serve/proxy/`;
  const host = req.get("host") ?? "localhost";
  return `${req.protocol}://${host}/api/projects/${projectId}/serve/proxy/`;
}

// ── Language → executor ────────────────────────────────────────────────────────
function getCmd(language: string, filePath: string): { cmd: string; args: string[] } | null {
  switch (language) {
    case "javascript": case "js":  return { cmd: "node",    args: [filePath] };
    case "typescript": case "ts":  return { cmd: "bun",     args: ["run", filePath] };
    case "python": case "python3": case "py": return { cmd: "python3", args: [filePath] };
    default: return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseProjectId(req: Request): number {
  return parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
}

function killEntry(entry: ActiveServer) {
  if (entry.stopped) return;
  entry.stopped = true;
  if (entry.kind === "local") {
    // child.killed is set when the signal is *sent*, not when the process *exits*.
    // We track the actual exit with childExited and clear the timer on normal close.
    entry.child.kill("SIGTERM");
    const escalateTimer = setTimeout(() => {
      if (!entry.childExited) entry.child.kill("SIGKILL");
    }, 3_000);
    entry.child.once("close", () => clearTimeout(escalateTimer));
  } else {
    entry.killTail?.();
    entry.killMonitor?.();
    entry.killTunnel?.();
    stopSshServerBackground(entry.srvConfig, entry.remotePid).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Reverse proxy — exported so app.ts can mount it BEFORE body-parser middleware.
// Body parsers consume req as a stream; the proxy must pipe it raw to the upstream
// server before any body-parser has had a chance to consume the stream.
// ══════════════════════════════════════════════════════════════════════════════
function proxyHandler(req: Request, res: Response): void {
  const projectId = parseProjectId(req);
  if (isNaN(projectId)) { res.status(400).send("Invalid project id"); return; }

  const entry = activeServers.get(projectId);
  if (!entry) { res.status(503).send("No server running for this project"); return; }

  // When mounted via router.use(), req.url is relative to the mount point —
  // it's already the sub-path the upstream server should receive.
  const proxyPath = req.url || "/";

  // Avoid transparent compression so raw bytes are piped unchanged.
  const headers = { ...req.headers };
  delete headers["accept-encoding"];
  delete headers["host"];

  const proxyReq = httpRequest(
    {
      hostname: "127.0.0.1",
      port: entry.port,   // SSH entries use the local tunnel port; local entries use the direct port
      path: proxyPath,
      method: req.method,
      headers: { ...headers, host: `localhost:${entry.port}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    },
  );

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: "Server not reachable", detail: err.message });
    }
  });

  req.pipe(proxyReq, { end: true });
}

// Build the proxy router as a named export so app.ts can mount it early.
const proxyMount = Router({ mergeParams: true });
proxyMount.use(proxyHandler);

export const serveProxyRouter: IRouter = Router();
serveProxyRouter.use("/api/projects/:id/serve/proxy", proxyMount);

// ══════════════════════════════════════════════════════════════════════════════
// Authenticated API routes
// ══════════════════════════════════════════════════════════════════════════════
const router: IRouter = Router();

// ── GET /projects/:id/serve — status ─────────────────────────────────────────
router.get("/projects/:id/serve", requireAuth, (req, res): void => {
  const { userId } = getUser(req);
  const projectId = parseProjectId(req);
  const entry = activeServers.get(projectId);
  if (!entry || entry.userId !== userId) { res.json({ running: false }); return; }
  res.json({ running: true, url: entry.url, port: entry.port, startedAt: entry.startedAt });
});

// ── GET /projects/:id/serve/logs — SSE stream ─────────────────────────────────
router.get("/projects/:id/serve/logs", requireAuth, (req, res): void => {
  const { userId } = getUser(req);
  const projectId = parseProjectId(req);
  const entry = activeServers.get(projectId);
  if (!entry || entry.userId !== userId) {
    res.status(404).json({ error: "No active server for this project" }); return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendLine = (line: LogLine) => {
    res.write(`data: ${JSON.stringify({ type: line.type, payload: line.text })}\n\n`);
  };

  res.write(`data: ${JSON.stringify({ type: "url", payload: entry.url })}\n\n`);

  for (const line of entry.logBuffer) {
    if (!line.text.startsWith("__SERVE_EXIT__")) sendLine(line);
  }

  const listener = (line: LogLine) => {
    if (line.text.startsWith("__SERVE_EXIT__")) {
      const code = line.text.slice("__SERVE_EXIT__".length);
      res.write(`data: ${JSON.stringify({ type: "exit", payload: code })}\n\n`);
      res.end();
    } else {
      sendLine(line);
    }
  };
  entry.logListeners.add(listener);
  req.on("close", () => { entry.logListeners.delete(listener); });
});

// ── POST /projects/:id/serve — start ─────────────────────────────────────────
router.post("/projects/:id/serve", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const projectId = parseProjectId(req);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const { fileId } = req.body ?? {};
  if (!fileId) { res.status(400).json({ error: "fileId is required" }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId))).limit(1);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [file] = await db.select().from(projectFilesTable)
    .where(and(eq(projectFilesTable.id, fileId), eq(projectFilesTable.projectId, projectId))).limit(1);
  if (!file) { res.status(404).json({ error: "File not found" }); return; }

  if (!getCmd(file.language, "")) {
    res.status(400).json({ error: `Language not supported for serve: ${file.language}` }); return;
  }

  // Stop any existing server for this project, then remove it
  const existing = activeServers.get(projectId);
  if (existing) { killEntry(existing); activeServers.delete(projectId); }

  const allFiles = await db.select().from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  const port = await findFreePort();
  const url = buildProxyUrl(req, projectId);

  // ── SSH serve ────────────────────────────────────────────────────────────
  if (project.serverId) {
    const [srvRow] = await db.select().from(serversTable)
      .where(and(eq(serversTable.id, project.serverId), eq(serversTable.userId, userId))).limit(1);
    if (!srvRow) { res.status(404).json({ error: "SSH server not found" }); return; }

    const srvConfig: SshServerConfig = {
      host: srvRow.host, port: srvRow.port,
      username: srvRow.username, password: srvRow.password, privateKey: srvRow.privateKey,
    };

    // 1) Start the background process on the remote machine
    let remotePid: number;
    try {
      remotePid = await startSshServerBackground(
        srvConfig, projectId, allFiles, file.path, file.language, port,
      );
    } catch (err: unknown) {
      res.status(502).json({ error: `SSH serve failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    // 2) Create a local TCP tunnel: localhost:port → remote:port
    //    This makes the existing HTTPS proxy URL work for SSH projects too.
    let killTunnel: (() => void) | null = null;
    try {
      killTunnel = await startSshTunnel(srvConfig, port);
    } catch (err: unknown) {
      // Tunnel failed — kill the remote process and bail
      stopSshServerBackground(srvConfig, remotePid).catch(() => {});
      res.status(502).json({
        error: `SSH tunnel failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const entry: SshServer = {
      kind: "ssh", projectId, userId, port, url, startedAt: new Date(),
      logBuffer: [], logListeners: new Set(),
      stopped: false, exitEmitted: false,
      srvConfig, remotePid,
      killTunnel,
      killMonitor: null,
      killTail: null,
    };
    activeServers.set(projectId, entry);

    broadcast(entry, { type: "system", text: `[SSH server started — PID ${remotePid}]`, ts: Date.now() });
    broadcast(entry, { type: "system", text: `[Preview URL ready via SSH tunnel]`, ts: Date.now() });

    // 3) Monitor the remote PID so we detect crashes and update the UI
    startSshPidMonitor(srvConfig, remotePid, () => {
      if (!entry.stopped) {
        broadcast(entry, { type: "system", text: "[Remote server process exited]", ts: Date.now() });
        evictIfCurrent(entry);
        broadcastExit(entry, -1);
      }
    }).then((kill) => { entry.killMonitor = kill; })
      .catch(() => { /* monitoring optional — ignore connection failures */ });

    // 4) Tail the remote log file for live output
    startSshLogTail(
      srvConfig, projectId,
      (line) => broadcast(entry, { type: "stdout", text: line, ts: Date.now() }),
      (_code) => {
        // tail -F may exit when log file is deleted — PID monitor handles the real exit
      },
    ).then((kill) => { entry.killTail = kill; })
      .catch((err: unknown) => {
        broadcast(entry, { type: "system", text: `[Log tail unavailable: ${err instanceof Error ? err.message : String(err)}]`, ts: Date.now() });
      });

    res.json({ url, port, startedAt: entry.startedAt });
    return;
  }

  // ── Local serve ──────────────────────────────────────────────────────────
  let projDir: string;
  try {
    projDir = await syncProjectFiles(projectId, allFiles);
  } catch {
    res.status(500).json({ error: "Failed to prepare project files" }); return;
  }

  const absFilePath = join(projDir, file.path);
  const { cmd, args } = getCmd(file.language, absFilePath)!;

  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG,
    PORT: String(port),
    PYTHONPATH: undefined,
    PYTHONHOME: undefined,
  };

  const child: ChildProcess = spawn(cmd, args, { env: safeEnv, cwd: projDir, stdio: "pipe" });
  child.stdin?.on("error", () => {}); // suppress unhandled EPIPE

  const entry: LocalServer = {
    kind: "local", projectId, userId, port, url, startedAt: new Date(),
    logBuffer: [], logListeners: new Set(),
    stopped: false, exitEmitted: false,
    child, childExited: false,
  };
  activeServers.set(projectId, entry);

  broadcast(entry, { type: "system", text: `[Server starting on port ${port}…]`, ts: Date.now() });

  child.stdout?.on("data", (chunk: Buffer) => {
    chunk.toString("utf8").split("\n").filter(Boolean).forEach((line) =>
      broadcast(entry, { type: "stdout", text: line, ts: Date.now() }),
    );
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    chunk.toString("utf8").split("\n").filter(Boolean).forEach((line) =>
      broadcast(entry, { type: "stderr", text: line, ts: Date.now() }),
    );
  });

  // Identity-aware cleanup: only evict this entry if it is still the current
  // one — a replace-start may have already registered a newer server.
  child.on("close", (code) => {
    entry.childExited = true;   // used by the SIGKILL escalation timer
    evictIfCurrent(entry);
    broadcastExit(entry, code);
  });
  child.on("error", (err) => {
    entry.childExited = true;
    broadcast(entry, { type: "stderr", text: `[Process error: ${err.message}]`, ts: Date.now() });
    evictIfCurrent(entry);
    broadcastExit(entry, -1);
  });

  res.json({ url, port, startedAt: entry.startedAt });
});

// ── DELETE /projects/:id/serve — stop ────────────────────────────────────────
router.delete("/projects/:id/serve", requireAuth, (req, res): void => {
  const { userId } = getUser(req);
  const projectId = parseProjectId(req);
  const entry = activeServers.get(projectId);
  if (!entry || entry.userId !== userId) {
    res.status(404).json({ error: "No active server for this project" }); return;
  }

  broadcast(entry, { type: "system", text: "[Server stopped by user]", ts: Date.now() });
  killEntry(entry);
  evictIfCurrent(entry);
  broadcastExit(entry, 0);

  res.status(204).end();
});

export default router;
