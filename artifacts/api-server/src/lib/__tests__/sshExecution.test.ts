import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "crypto";
import { execFileSync, spawn, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { createConnection } from "net";
import * as http from "http";
import express from "express";
import request from "supertest";
import {
  buildRemoteProcessGroupStopCommand,
  createRemoteProcessAborter,
  streamRemoteProcess,
  type SshServerConfig,
} from "../sshExecution";
import type { ProjectFile } from "@workspace/db";

const RUN_SSH_INTEGRATION = process.env.SSH_INTEGRATION === "1";

const { mockDbSelect, selectQueue, mockRequireAuth, mockGetUser } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const mockDbSelect = vi.fn(() => {
    const value = selectQueue.shift() ?? [];
    const result = Promise.resolve(value);
    const query = {
      then: result.then.bind(result),
      catch: result.catch.bind(result),
      limit: vi.fn(() => result),
    };
    return { from: vi.fn(() => ({ where: vi.fn(() => query) })) };
  });
  const mockRequireAuth = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
  const mockGetUser = vi.fn(() => ({ userId: 1, email: "test@example.com", username: "test" }));
  return { mockDbSelect, selectQueue, mockRequireAuth, mockGetUser };
});

vi.mock("@workspace/db", () => ({
  db: { select: mockDbSelect },
  projectsTable: { id: "id", userId: "userId", serverId: "serverId" },
  projectFilesTable: { id: "id", projectId: "projectId" },
  serversTable: { id: "id", userId: "userId" },
  projectEnvVarsTable: { projectId: "projectId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (_column: unknown, value: unknown) => ({ eq: value }),
  and: (...conditions: unknown[]) => ({ and: conditions }),
}));

vi.mock("../../lib/auth.js", () => ({
  requireAuth: mockRequireAuth,
  getUser: mockGetUser,
}));

const { default: executionRouter } = await import("../../routes/execution.js");

type SshFixture = {
  config: SshServerConfig;
  stop: () => Promise<void>;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(port: number, processHandle: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error("SSH fixture exited before accepting connections");
    }
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await wait(50);
  }
  throw new Error(`SSH fixture did not start on port ${port}`);
}

async function createSshFixture(): Promise<SshFixture> {
  const directory = mkdtempSync(join(tmpdir(), "clownin-ssh-fixture-"));
  const hostKeyPath = join(directory, "host-key");
  const userKeyPath = join(directory, "user-key");
  const authorizedKeysPath = join(directory, "authorized_keys");
  const configPath = join(directory, "sshd_config");
  const pidPath = join(directory, "sshd.pid");

  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ format: "pem", type: "pkcs1" });
  const userKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const userKey = userKeyPair.privateKey.export({ format: "pem", type: "pkcs1" });
  writeFileSync(hostKeyPath, hostKey, { mode: 0o600 });
  writeFileSync(userKeyPath, userKey, { mode: 0o600 });

  const authorizedKey = execFileSync("ssh-keygen", ["-y", "-f", userKeyPath], {
    encoding: "utf8",
  });
  writeFileSync(authorizedKeysPath, authorizedKey, { mode: 0o600 });

  // The runtime-provided sshd and sftp-server live beside one another.
  const sshdPath = execFileSync("sh", ["-c", "command -v sshd"], { encoding: "utf8" }).trim();
  const sftpPath = join(dirname(sshdPath), "..", "libexec", "sftp-server");
  const nodePath = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
  const port = 22_000 + Math.floor(Math.random() * 5_000);
  const username = process.env.USER ?? "runner";

  writeFileSync(
    configPath,
    [
      `HostKey ${hostKeyPath}`,
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `PidFile ${pidPath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      "PubkeyAuthentication yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "UsePAM no",
      "StrictModes no",
      "PermitUserEnvironment no",
      "AllowAgentForwarding no",
      "AllowTcpForwarding no",
      "X11Forwarding no",
      "LogLevel ERROR",
      `SetEnv PATH=${dirname(nodePath)}:${process.env.PATH ?? ""}`,
      `Subsystem sftp ${sftpPath}`,
    ].join("\n") + "\n",
    { mode: 0o600 },
  );

  const check = spawnSync(sshdPath, ["-t", "-f", configPath], { encoding: "utf8" });
  if (check.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Invalid SSH fixture config:\n${check.stderr}`);
  }

  const sshd = spawn(sshdPath, ["-D", "-e", "-f", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  sshd.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  try {
    await waitForPort(port, sshd);
  } catch (error) {
    sshd.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  }

  const config: SshServerConfig = {
    host: "127.0.0.1",
    port,
    username,
    privateKey: readFileSync(userKeyPath, "utf8"),
  };

  return {
    config,
    stop: async () => {
      if (sshd.exitCode === null) {
        sshd.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => sshd.once("exit", () => resolve())),
          wait(2_000),
        ]);
      }
      if (sshd.exitCode === null) sshd.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function waitForChildExit(pid: number): Promise<void> {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await wait(50);
  }
  throw new Error(`Remote child process ${pid} survived cancellation`);
}

function queueRemoteExecution(fixture: SshFixture, projectId: number, files: ProjectFile[]): void {
  selectQueue.splice(0, selectQueue.length,
    [{ id: projectId, userId: 1, serverId: 1 }],
    [files[0]],
    files,
    [],
    [{ id: 1, userId: 1, ...fixture.config }],
  );
}

type ExecutionServer = {
  server: http.Server;
};

async function startExecutionServer(): Promise<ExecutionServer> {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).log = {
      info: () => {},
      error: () => {},
    };
    next();
  });
  app.use(express.json());
  app.use(executionRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return { server };
}

async function stopExecutionServer(executionServer: ExecutionServer): Promise<void> {
  await new Promise<void>((resolve) => executionServer.server.close(() => resolve()));
}

type SseRun = {
  token: Promise<string>;
  childPid: Promise<number>;
  exitEvents: string[];
  stderr: string[];
  disconnect: () => void;
};

function openExecutionSse(server: http.Server, projectId: number, fileId: number): SseRun {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Execution server has no TCP address");

  let resolveToken!: (token: string) => void;
  let rejectToken!: (error: Error) => void;
  let resolveChildPid!: (pid: number) => void;
  let rejectChildPid!: (error: Error) => void;
  const token = new Promise<string>((resolve, reject) => { resolveToken = resolve; rejectToken = reject; });
  const childPid = new Promise<number>((resolve, reject) => { resolveChildPid = resolve; rejectChildPid = reject; });
  const exitEvents: string[] = [];
  const stderr: string[] = [];
  let settled = false;
  let response: http.IncomingMessage | undefined;
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectToken(error);
    rejectChildPid(error);
  };

  const req = http.request({
    host: "127.0.0.1",
    port: address.port,
    method: "POST",
    path: `/projects/${projectId}/execute`,
    headers: { "Content-Type": "application/json" },
  }, (res) => {
    response = res;
    let buffer = "";
    res.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        if (!event.startsWith("data: ")) continue;
        const message = JSON.parse(event.slice(6)) as { type: string; payload: string };
        if (message.type === "token") resolveToken(message.payload);
        if (message.type === "stdout") {
          const match = message.payload.match(/CHILD_PID=(\d+)/);
          if (match) resolveChildPid(Number.parseInt(match[1], 10));
        }
        if (message.type === "stderr") stderr.push(message.payload);
        if (message.type === "exit") {
          exitEvents.push(message.payload);
          settled = true;
        }
      }
    });
    res.on("error", fail);
  });
  req.on("error", fail);
  req.end(JSON.stringify({ fileId }));

  return {
    token,
    childPid,
    exitEvents,
    stderr,
    disconnect: () => {
      response?.destroy();
      req.destroy();
    },
  };
}

async function waitForExitEvent(run: SseRun, cancellation: "stop" | "disconnect"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (run.exitEvents.length === 0 && Date.now() < deadline) await wait(25);
  if (run.exitEvents.length === 0) {
    throw new Error(`Remote ${cancellation} did not emit a terminal finalization event promptly`);
  }
}

async function runRemoteCancellationCase(
  fixture: SshFixture,
  cancellation: "stop" | "disconnect",
): Promise<void> {
  const projectId = Math.floor(Math.random() * 1_000_000) + 1;
  const files: ProjectFile[] = [{
    id: projectId,
    projectId,
    path: "parent.js",
    language: "javascript",
    content: [
      "const { spawn } = require('child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "console.log(`CHILD_PID=${child.pid}`);",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    createdAt: new Date(),
    updatedAt: new Date(),
  }];
  mockDbSelect.mockClear();
  queueRemoteExecution(fixture, projectId, files);
  const executionServer = await startExecutionServer();
  const run = openExecutionSse(executionServer.server, projectId, files[0].id);
  let token: string | undefined;
  try {
    token = await Promise.race([
      run.token,
      wait(5_000).then(() => { throw new Error("Remote run did not emit a token"); }),
    ]);
    const childPid = await Promise.race([
      run.childPid,
      wait(5_000).then(() => { throw new Error("Remote parent did not start a child"); }),
    ]);

    if (cancellation === "stop") {
      await request(executionServer.server)
        .post(`/projects/${projectId}/execute/cancel`)
        .send({ token })
        .expect(204);
    } else {
      run.disconnect();
    }

    if (cancellation === "stop") await waitForExitEvent(run, cancellation);
    await waitForChildExit(childPid);
    await wait(100);

    expect(run.stderr).toEqual([]);
    if (cancellation === "stop") expect(run.exitEvents).toHaveLength(1);
  } finally {
    if (token) {
      await request(executionServer.server)
        .post(`/projects/${projectId}/execute/cancel`)
        .send({ token })
        .expect(204);
    }
    run.disconnect();
    await stopExecutionServer(executionServer);
    rmSync(join(homedir(), ".clownin", String(projectId)), { recursive: true, force: true });
  }
}

describe("remote process-group stop command", () => {
  it("terminates the entire process group before escalating to KILL", () => {
    const command = buildRemoteProcessGroupStopCommand(4312);

    expect(command).toContain("kill -0 -4312");
    expect(command).toContain("kill -TERM -4312");
    expect(command).toContain("kill -KILL -4312");
    expect(command).toContain("sleep 1");
  });

  it.each([0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsafe process group id %s",
    (pgid) => {
      expect(() => buildRemoteProcessGroupStopCommand(pgid)).toThrow("Invalid remote process group");
    },
  );
});

describe("remote execution cancellation", () => {
  it("keeps the exec channel open for a delayed PGID marker, then kills that group", () => {
    const stopProcessGroup = vi.fn();
    const closeStream = vi.fn();
    const aborter = createRemoteProcessAborter(stopProcessGroup, closeStream, 50);

    aborter.abort();
    // The marker is transported on the exec channel's stderr. It must stay
    // open so the marker can be received after the client has cancelled.
    expect(closeStream).not.toHaveBeenCalled();
    expect(stopProcessGroup).not.toHaveBeenCalled();

    aborter.setProcessGroup(4312);
    aborter.abort();

    expect(stopProcessGroup).toHaveBeenCalledTimes(1);
    expect(stopProcessGroup).toHaveBeenCalledWith(4312);
    expect(closeStream).toHaveBeenCalledTimes(1);
  });

  it("closes a cancelled stream when no PGID marker arrives during the grace period", () => {
    vi.useFakeTimers();
    const stopProcessGroup = vi.fn();
    const closeStream = vi.fn();
    const aborter = createRemoteProcessAborter(stopProcessGroup, closeStream, 50);

    aborter.abort();
    expect(closeStream).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(stopProcessGroup).not.toHaveBeenCalled();
    expect(closeStream).toHaveBeenCalledTimes(1);
    aborter.dispose();
    vi.useRealTimers();
  });
});

describe.skipIf(!RUN_SSH_INTEGRATION)("SSH fixture remote cancellation", () => {
  let fixture: SshFixture;

  beforeAll(async () => {
    fixture = await createSshFixture();
  }, 15_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  it("stops a remote parent and child process group through the Stop path", async () => {
    await runRemoteCancellationCase(fixture, "stop");
  }, 15_000);

  it("stops a remote parent and child process group when the SSE client disconnects", async () => {
    await runRemoteCancellationCase(fixture, "disconnect");
  }, 15_000);
});