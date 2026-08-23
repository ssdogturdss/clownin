/**
 * Integration regression coverage for the owner-bound live preview bootstrap.
 *
 * The user project is a real local HTTP server; Docker is mocked only at the
 * sandbox boundary so this test can exercise the API route, redirect/cookie
 * exchange, reverse proxy, and stop lifecycle without requiring Docker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, createServer, type Server } from "http";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import express from "express";
import request from "supertest";

const PROJECT_ID = 701;
const FILE_ID = 702;
const OWNER_ID = 31;
const OWNER_BOOTSTRAP_TOKEN = "owner-preview-bootstrap";

const {
  mockDbSelect,
  selectQueue,
  mockRequireAuth,
  mockGetUser,
  mockSignPreviewToken,
  mockVerifyPreviewToken,
  mockSyncProjectFiles,
  mockStartSandboxServer,
  mockStopSandbox,
  mockCleanupSandboxBroker,
  mockWaitForSandboxExit,
  mockSpawn,
} = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const mockDbSelect = vi.fn(() => {
    const result = Promise.resolve(selectQueue.shift() ?? []);
    const query = {
      then: result.then.bind(result),
      catch: result.catch.bind(result),
      limit: vi.fn(() => result),
    };
    return { from: vi.fn(() => ({ where: vi.fn(() => query) })) };
  });

  return {
    mockDbSelect,
    selectQueue,
    mockRequireAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
    mockGetUser: vi.fn(() => ({ userId: OWNER_ID, email: "owner@test.com", username: "owner" })),
    mockSignPreviewToken: vi.fn(() => OWNER_BOOTSTRAP_TOKEN),
    mockVerifyPreviewToken: vi.fn((token: string) => {
      if (token !== OWNER_BOOTSTRAP_TOKEN) throw new Error("Invalid preview token");
      return { scope: "preview" as const, projectId: PROJECT_ID, userId: OWNER_ID };
    }),
    mockSyncProjectFiles: vi.fn(),
    mockStartSandboxServer: vi.fn(),
    mockStopSandbox: vi.fn(),
    mockCleanupSandboxBroker: vi.fn(),
    mockWaitForSandboxExit: vi.fn(),
    mockSpawn: vi.fn(),
  };
});

vi.mock("@workspace/db", () => ({
  db: { select: mockDbSelect },
  projectsTable: { id: "id", userId: "userId", serverId: "serverId" },
  projectFilesTable: { id: "id", projectId: "projectId" },
  serversTable: { id: "id", userId: "userId" },
  projectEnvVarsTable: { projectId: "projectId", key: "key", encryptedValue: "encryptedValue" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (_column: unknown, value: unknown) => ({ eq: value }),
  and: (...conditions: unknown[]) => ({ and: conditions }),
}));

vi.mock("../../lib/auth.js", () => ({
  requireAuth: mockRequireAuth,
  getUser: mockGetUser,
  signPreviewToken: mockSignPreviewToken,
  verifyPreviewToken: mockVerifyPreviewToken,
  getSystemUserId: () => 1,
}));

vi.mock("../../lib/projectWorkspace.js", () => ({
  syncProjectFiles: mockSyncProjectFiles,
}));

vi.mock("../../lib/envCrypto.js", () => ({
  decrypt: vi.fn(),
  filterUserEnv: (env: Record<string, string>) => env,
}));

vi.mock("../../lib/sandbox.js", () => ({
  cleanupSandboxBroker: mockCleanupSandboxBroker,
  startSandboxServer: mockStartSandboxServer,
  stopSandbox: mockStopSandbox,
  waitForSandboxExit: mockWaitForSandboxExit,
}));

vi.mock("../../lib/sshExecution.js", () => ({
  startSshServerBackground: vi.fn(),
  startSshLogTail: vi.fn(),
  startSshTunnel: vi.fn(),
  startSshPidMonitor: vi.fn(),
  stopSshServerBackground: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
}));

const { default: serveRouter, serveProxyRouter, cleanupAllServers } =
  await import("../serve.js");

function makeChildProcess() {
  const child = new EventEmitter();
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    unref: vi.fn(),
  });
  return child;
}

function queueOwnedProject() {
  const file = {
    id: FILE_ID,
    projectId: PROJECT_ID,
    path: "server.js",
    language: "javascript",
    content: "ignored by the sandbox mock",
  };
  selectQueue.push(
    [{ id: PROJECT_ID, userId: OWNER_ID, serverId: null }],
    [file],
    [file],
    [],
  );
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Preview fixture did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("live preview authorization bootstrap", () => {
  let previewServer: Server | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    mockSyncProjectFiles.mockResolvedValue("/tmp/clownin-preview-test");
    mockWaitForSandboxExit.mockImplementation(makeChildProcess);
    mockSpawn.mockImplementation(makeChildProcess);
  });

  afterEach(async () => {
    cleanupAllServers();
    if (previewServer) {
      await close(previewServer);
      previewServer = undefined;
    }
  });

  it("serves an owner bootstrap URL, rejects a bare URL, and returns 503 after stop", async () => {
    let forwardedCookie: string | string[] | undefined;
    previewServer = createServer((req, res) => {
      forwardedCookie = req.headers.cookie;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<main>owner preview is live</main>");
    });
    const upstreamPort = await listen(previewServer);

    const agent = new Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => {
      const socket = require("net").connect(upstreamPort, "127.0.0.1");
      if (callback) socket.once("connect", () => callback(null, socket));
      return socket;
    };
    mockStartSandboxServer.mockResolvedValue({
      containerId: "preview-container",
      port: 3000,
      broker: { createHttpAgent: () => agent },
    });

    const app = express();
    // Keep the same ordering as the production app: proxy before body parsing.
    app.use(serveProxyRouter);
    app.use(express.json());
    app.use("/api", serveRouter);

    queueOwnedProject();
    const start = await request(app)
      .post(`/api/projects/${PROJECT_ID}/serve`)
      .set("Authorization", "Bearer owner-session")
      .send({ fileId: FILE_ID })
      .expect(200);

    const proxyPath = `/api/projects/${PROJECT_ID}/serve/proxy/`;
    expect(start.body.url).toContain(proxyPath);

    // A live preview stays private until the owner has supplied its bootstrap
    // capability; this is deliberately a 401, not a proxy failure.
    await request(app)
      .get(proxyPath)
      .redirects(0)
      .expect(401, "Preview authorization required");

    const tokenResponse = await request(app)
      .get(`/api/projects/${PROJECT_ID}/serve/preview-token`)
      .set("Authorization", "Bearer owner-session")
      .expect(200);
    expect(tokenResponse.body).toEqual({ token: OWNER_BOOTSTRAP_TOKEN });

    const bootstrap = await request(app)
      .get(`${proxyPath}?preview_token=${encodeURIComponent(tokenResponse.body.token)}`)
      .redirects(0)
      .expect(302);
    expect(bootstrap.headers.location).toBe(proxyPath);
    expect(bootstrap.headers["set-cookie"]).toEqual([
      expect.stringContaining(`clownin_preview_${PROJECT_ID}=${OWNER_BOOTSTRAP_TOKEN}`),
    ]);

    const previewCookie = bootstrap.headers["set-cookie"][0].split(";")[0];
    const preview = await request(app)
      .get(bootstrap.headers.location)
      .set("Cookie", previewCookie)
      .expect(200);
    expect(preview.text).toBe("<main>owner preview is live</main>");
    expect(forwardedCookie).toBeUndefined();

    await request(app)
      .delete(`/api/projects/${PROJECT_ID}/serve`)
      .set("Authorization", "Bearer owner-session")
      .expect(204);

    await request(app)
      .get(bootstrap.headers.location)
      .set("Cookie", previewCookie)
      .expect(503, "No server running for this project");
  });
});