import { createServer } from "http";
import net from "net";
import app from "./app";
import { logger } from "./lib/logger";
import { seedDemoData } from "./lib/seed";
import { cleanupAllServers, getActiveServerPort } from "./routes/serve";

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

server.on("upgrade", (req, socket: net.Socket, head: Buffer) => {
  const match = req.url?.match(WS_RE);
  if (!match) {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }

  const projectId = parseInt(match[1], 10);
  const subPath = match[2] || "/";
  const projectPort = getActiveServerPort(projectId);

  if (!projectPort) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }

  const upstream = net.connect(projectPort, "127.0.0.1", () => {
    // Reconstruct the HTTP/1.1 upgrade request for the upstream port,
    // replacing host so the child process sees its own address.
    const filteredHeaders = Object.entries(req.headers)
      .filter(([k]) => k !== "host")
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\r\n");

    upstream.write(
      `GET ${subPath} HTTP/1.1\r\n` +
        `host: localhost:${projectPort}\r\n` +
        filteredHeaders +
        "\r\n\r\n",
    );
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
    await seedDemoData();
  } catch (err) {
    logger.error({ err }, "Seed failed (non-fatal)");
  }
});
