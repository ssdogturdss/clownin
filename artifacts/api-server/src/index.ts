import { createServer } from "http";
import net from "net";
import app from "./app";
import { logger } from "./lib/logger";
import { seedDemoData, ensureSystemUser } from "./lib/seed";
import { setSystemUserId } from "./lib/auth";
import { cleanupAllServers, getAuthorizedServerTarget, stopPreviewForRelayFailure } from "./routes/serve";

const rawPort = process.env["PORT"];
if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}
const serverPort = Number(rawPort);
if (Number.isNaN(serverPort) || serverPort <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);

// ── WebSocket proxy ──────────────────────────────────────────────────────────
// Forwards WS upgrade requests at /api/projects/:id/serve/proxy/* to the
// local child-process server for that project.  HTTP requests go through
// Express (serveProxyRouter); WS upgrades bypass Express entirely and are
// handled here at the raw TCP layer.
const WS_RE = /^\/api\/projects\/(\d+)\/serve\/proxy(\/.*)?$/;

function previewCookie(req: { headers: { cookie?: string | undefined } }, projectId: number): string | null {
  const name = `clownin_preview_${projectId}=`;
  const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(name));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice(name.length));
  } catch {
    return null;
  }
}

function withoutPreviewCookie(header: string | undefined, projectId: number): string | undefined {
  const name = `clownin_preview_${projectId}=`;
  const retained = header?.split(";").map((part) => part.trim()).filter((part) => !part.startsWith(name));
  return retained?.length ? retained.join("; ") : undefined;
}

server.on("upgrade", (req, socket: net.Socket, head: Buffer) => {
  const match = req.url?.match(WS_RE);
  if (!match) {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }

  const projectId = parseInt(match[1], 10);
  const subPath = match[2] || "/";
  const target = getAuthorizedServerTarget(projectId, previewCookie(req, projectId));

  if (!target) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  if (target.kind === "unavailable") {
    stopPreviewForRelayFailure(projectId);
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return;
  }

  // Reconstruct the HTTP/1.1 upgrade request for the upstream server,
  // replacing host so preview code sees its own local address.
  const headers = { ...req.headers };
  const safeCookie = withoutPreviewCookie(headers.cookie, projectId);
  if (safeCookie) headers.cookie = safeCookie;
  else delete headers.cookie;
  const filteredHeaders = Object.entries(headers)
    .filter(([k]) => k !== "host")
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\r\n");
  const rawUpgrade = (
    `GET ${subPath} HTTP/1.1\r\n` +
    `host: localhost:${target.port}\r\n` +
    filteredHeaders +
    "\r\n\r\n"
  );

  if (target.kind === "sandbox") {
    let relay: ReturnType<typeof target.broker.createStream>;
    try {
      relay = target.broker.createStream();
    } catch (err) {
      logger.warn({ err, projectId }, "Sandbox WS relay unavailable");
      stopPreviewForRelayFailure(projectId);
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    relay.once("connect", () => {
      relay.write(rawUpgrade);
      if (head?.length) relay.write(head);
      socket.pipe(relay);
      relay.pipe(socket);
    });
    relay.on("error", (err) => {
      logger.warn({ err, projectId }, "Sandbox WS relay error");
      socket.destroy();
    });
    relay.on("close", () => socket.destroy());
    socket.on("error", () => relay.destroy());
    socket.on("close", () => relay.destroy());
    return;
  }

  const upstream = net.connect(target.port, "127.0.0.1", () => {
    upstream.write(rawUpgrade);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on("error", (err) => {
    logger.warn({ err, projectId }, "WS upstream error");
    socket.destroy();
  });
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Kill all child processes before exiting so they don't become orphans when
// the API server is restarted (e.g. by a code deploy or workflow restart).
function gracefulShutdown(signal: string): void {
  logger.info({ signal }, "Shutting down — cleaning up child processes");
  cleanupAllServers();
  server.close(() => process.exit(0));
  // Force exit after 5 s in case lingering HTTP keep-alive connections stall
  // server.close() from ever completing.
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ── Start ────────────────────────────────────────────────────────────────────
server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

server.listen(serverPort, async () => {
  logger.info({ port: serverPort }, "Server listening");
  try {
    const uid = await ensureSystemUser();
    setSystemUserId(uid);
    logger.info({ systemUserId: uid }, "Auth disabled — running as system user");
  } catch (err) {
    logger.error({ err }, "System user setup failed (non-fatal, defaulting to userId=1)");
  }
  try {
    await seedDemoData();
  } catch (err) {
    logger.error({ err }, "Seed failed (non-fatal)");
  }
});
