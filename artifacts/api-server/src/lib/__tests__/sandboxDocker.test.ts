/**
 * Real Docker regression coverage for the local preview sandbox.
 *
 * Opt-in because it builds/runs a container. Run with:
 *   DOCKER_SANDBOX=1 pnpm --filter @workspace/api-server exec vitest run src/lib/__tests__/sandboxDocker.test.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { request } from "http";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { startSandboxServer, stopSandbox, type SandboxServer } from "../sandbox";

const RUN_DOCKER = process.env.DOCKER_SANDBOX === "1";
let sandbox: SandboxServer | null = null;
let projectDir: string | null = null;

afterEach(async () => {
  if (sandbox) stopSandbox(sandbox.containerId, sandbox.broker);
  if (projectDir) await rm(projectDir, { recursive: true, force: true });
  sandbox = null;
  projectDir = null;
});

function requestPreview(
  broker: SandboxServer["broker"],
  options: { path?: string; method?: string; body?: Buffer } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({
      agent: broker.createHttpAgent(),
      hostname: "preview.local",
      path: options.path ?? "/",
      method: options.method ?? "GET",
      headers: options.body ? { "content-length": options.body.length } : undefined,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

describe.skipIf(!RUN_DOCKER)("local preview Docker sandbox", () => {
  it("proxies a preview without host files, server secrets, egress, or published ports", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "clownin-sandbox-test-"));
    await chmod(projectDir, 0o755);
    await writeFile(join(projectDir, "index.js"), `
      const fs = require("fs");
      const http = require("http");
      const net = require("net");
      http.createServer((req, res) => {
        if (req.url === "/large") {
          res.end(Buffer.alloc(1.5 * 1024 * 1024, "x"));
          return;
        }
        if (req.method === "POST") {
          let received = 0;
          req.on("data", (chunk) => { received += chunk.length; });
          req.on("end", () => res.end(String(received)));
          return;
        }
        const send = (egress) => res.end(JSON.stringify({
          hostFiles: fs.existsSync("/home/runner/workspace"),
          serverSecret: process.env.JWT_SECRET || null,
          relayTampered: (() => {
            try {
              fs.unlinkSync("/relay/broker.sock");
              fs.symlinkSync("/var/run/docker.sock", "/relay/broker.sock");
              return true;
            } catch {
              return false;
            }
          })(),
          egress,
        }));
        net.connect({ host: "1.1.1.1", port: 53 })
          .on("connect", () => send("unexpected"))
          .on("error", () => send("blocked"));
      }).listen(process.env.PORT, "0.0.0.0");
    `, "utf8");

    sandbox = await startSandboxServer({
      projectDir,
      runtime: "node",
      args: ["/workspace/index.js"],
      env: { PATH: process.env.PATH },
    });

    await expect.poll(
      () => requestPreview(sandbox!.broker).catch(() => ""),
      { timeout: 5_000 },
    ).toBe(JSON.stringify({ hostFiles: false, serverSecret: null, relayTampered: false, egress: "blocked" }));

    const largeRequest = Buffer.alloc(1.5 * 1024 * 1024, "r");
    await expect(requestPreview(sandbox.broker, { method: "POST", body: largeRequest }))
      .resolves.toBe(String(largeRequest.length));
    await expect(requestPreview(sandbox.broker, { path: "/large" }))
      .resolves.toHaveLength(1.5 * 1024 * 1024);

    const inspect = spawnSync(
      "docker",
      ["inspect", sandbox.containerId, "--format", "{{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.PidsLimit}} {{.HostConfig.Memory}} {{.Config.User}} {{json .HostConfig.CapDrop}} {{json .NetworkSettings.Ports}}"],
      { encoding: "utf8" },
    );
    expect(inspect.status).toBe(0);
    expect(inspect.stdout).toContain("none true 64 402653184 65534:65534 [\"ALL\"] {}");
    expect(existsSync(sandbox.broker.socketPath)).toBe(true);

    // A preview can kill its relay sibling. Callers must treat that as a failed
    // upstream rather than allowing stream creation to crash the API process.
    sandbox.broker.close();
    expect(sandbox.broker.isConnected()).toBe(false);
    expect(() => sandbox!.broker.createStream()).toThrow("Preview relay is not connected");
  }, 120_000);
});