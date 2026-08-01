/**
 * Docker build + start smoke tests.
 * Verifies that the generated container config actually builds and starts for
 * each advertised server scenario.
 *
 * Run only when DOCKER_SMOKE=1 is set to avoid pulling images during normal
 * unit test runs:
 *
 *   pnpm test:docker          # run all Docker smoke tests
 *   pnpm test                 # skips these (no Docker required)
 *
 * Timeout: 10 minutes per test to allow for cold image pulls.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { generateContainerFiles, type FileEntry } from "../deployConfig";

const RUN_DOCKER = process.env.DOCKER_SMOKE === "1";

// ─── helpers ────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function makeTmpDir(files: Array<{ path: string; content: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clownin-smoke-"));
  for (const f of files) {
    const full = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content, "utf8");
  }
  return dir;
}

function dockerBuild(dir: string, tag: string): void {
  const result = spawnSync(
    "docker",
    ["build", "--quiet", "-t", tag, "."],
    { cwd: dir, encoding: "utf8", timeout: TIMEOUT_MS }
  );
  if (result.status !== 0) {
    throw new Error(
      `docker build failed (tag=${tag}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
}

function dockerRun(tag: string, hostPort: number, envPort: number): string {
  const result = spawnSync(
    "docker",
    ["run", "-d", "-p", `${hostPort}:${envPort}`, "-e", `PORT=${envPort}`, tag],
    { encoding: "utf8", timeout: 30_000 }
  );
  if (result.status !== 0) {
    throw new Error(`docker run failed (tag=${tag}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForHttp(url: string, maxMs = 8000): boolean {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = spawnSync("curl", ["-sf", "--max-time", "1", url], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (res.status === 0) return true;
    sleep(500);
  }
  return false;
}

function containerRunning(id: string): boolean {
  const res = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.Running}}", id],
    { encoding: "utf8", timeout: 5000 }
  );
  return res.stdout.trim() === "true";
}

const runningContainers: string[] = [];

afterEach(() => {
  for (const id of runningContainers.splice(0)) {
    spawnSync("docker", ["rm", "-f", id], { encoding: "utf8", timeout: 10_000 });
  }
});

/** Allocate a unique host port per test to avoid collisions. */
let portCounter = 19800;
function nextPort(): number { return portCounter++; }

// ─── scenarios ───────────────────────────────────────────────────────────────

describe.skipIf(!RUN_DOCKER)(
  "Docker smoke — Flask without requirements.txt",
  () => {
    const inputFiles: FileEntry[] = [
      {
        path: "app.py",
        content: [
          "from flask import Flask",
          "import os",
          "app = Flask(__name__)",
          "@app.route('/')",
          "def index(): return 'ok'",
        ].join("\n"),
      },
    ];
    const tag = "clownin-smoke-flask-no-req:test";

    it("builds successfully", () => {
      const { files, isContainerReady } = generateContainerFiles(inputFiles);
      expect(isContainerReady).toBe(true);
      const dir = makeTmpDir(files);
      try { dockerBuild(dir, tag); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, TIMEOUT_MS);

    it("starts and responds on a custom PORT", () => {
      const { files } = generateContainerFiles(inputFiles);
      const dir = makeTmpDir(files);
      try { dockerBuild(dir, tag); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }

      const envPort = 9001;
      const hostPort = nextPort();
      const cid = dockerRun(tag, hostPort, envPort);
      runningContainers.push(cid);

      const ok = waitForHttp(`http://localhost:${hostPort}/`, 10_000);
      if (!ok) {
        const logs = spawnSync("docker", ["logs", cid], { encoding: "utf8", timeout: 5000 });
        throw new Error(`Flask did not respond on PORT=${envPort}.\nLogs:\n${logs.stdout}\n${logs.stderr}`);
      }
      expect(containerRunning(cid)).toBe(true);
    }, TIMEOUT_MS);
  }
);

describe.skipIf(!RUN_DOCKER)(
  "Docker smoke — FastAPI without requirements.txt",
  () => {
    const inputFiles: FileEntry[] = [
      {
        path: "main.py",
        content: [
          "from fastapi import FastAPI",
          "import os",
          "app = FastAPI()",
          "@app.get('/')",
          "def root(): return {'status': 'ok'}",
        ].join("\n"),
      },
    ];
    const tag = "clownin-smoke-fastapi-no-req:test";

    it("builds successfully", () => {
      const { files, isContainerReady } = generateContainerFiles(inputFiles);
      expect(isContainerReady).toBe(true);
      const dir = makeTmpDir(files);
      try { dockerBuild(dir, tag); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, TIMEOUT_MS);

    it("starts and responds on a custom PORT", () => {
      const { files } = generateContainerFiles(inputFiles);
      const dir = makeTmpDir(files);
      try { dockerBuild(dir, tag); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }

      const envPort = 9002;
      const hostPort = nextPort();
      const cid = dockerRun(tag, hostPort, envPort);
      runningContainers.push(cid);

      const ok = waitForHttp(`http://localhost:${hostPort}/`, 10_000);
      if (!ok) {
        const logs = spawnSync("docker", ["logs", cid], { encoding: "utf8", timeout: 5000 });
        throw new Error(`FastAPI did not respond on PORT=${envPort}.\nLogs:\n${logs.stdout}\n${logs.stderr}`);
      }
      expect(containerRunning(cid)).toBe(true);
    }, TIMEOUT_MS);
  }
);

describe.skipIf(!RUN_DOCKER)(
  "Docker smoke — Node plain JS without package.json",
  () => {
    const inputFiles: FileEntry[] = [
      {
        path: "index.js",
        content: [
          "const http = require('http');",
          "const port = process.env.PORT || 3000;",
          "const s = http.createServer((_, res) => { res.end('ok'); });",
          "s.listen(port);",
        ].join("\n"),
      },
    ];
    const tag = "clownin-smoke-node-js-no-pkg:test";

    it("builds successfully", () => {
      const { files, isContainerReady } = generateContainerFiles(inputFiles);
      expect(isContainerReady).toBe(true);
      const dir = makeTmpDir(files);
      try { dockerBuild(dir, tag); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, TIMEOUT_MS);

    it("starts and responds on a custom PORT", () => {
      const { files } = generateContainerFiles(inputFiles);
      const dir = makeTmpDir(files);
      try { dockerBuild(dir, tag); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }

      const envPort = 9003;
      const hostPort = nextPort();
      const cid = dockerRun(tag, hostPort, envPort);
      runningContainers.push(cid);

      const ok = waitForHttp(`http://localhost:${hostPort}/`, 10_000);
      if (!ok) {
        const logs = spawnSync("docker", ["logs", cid], { encoding: "utf8", timeout: 5000 });
        throw new Error(`Node server did not respond on PORT=${envPort}.\nLogs:\n${logs.stdout}\n${logs.stderr}`);
      }
      expect(containerRunning(cid)).toBe(true);
    }, TIMEOUT_MS);
  }
);

describe.skipIf(!RUN_DOCKER)(
  "Docker smoke — Express with HTML templates (server takes precedence over static)",
  () => {
    const inputFiles: FileEntry[] = [
      {
        path: "index.js",
        content: [
          "const http = require('http');",
          "const port = process.env.PORT || 3000;",
          "const s = http.createServer((_, res) => { res.end('ok'); });",
          "s.listen(port);",
        ].join("\n"),
      },
      { path: "public/index.html", content: "<html><body>hi</body></html>" },
    ];
    const tag = "clownin-smoke-express-with-html:test";

    it("builds successfully", () => {
      const { files, isContainerReady } = generateContainerFiles(inputFiles);
      expect(isContainerReady).toBe(true);
      const dir = makeTmpDir(files);
      try { dockerBuild(dir, tag); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, TIMEOUT_MS);

    it("starts and responds on a custom PORT", () => {
      const { files } = generateContainerFiles(inputFiles);
      const dir = makeTmpDir(files);
      try { dockerBuild(dir, tag); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }

      const envPort = 9004;
      const hostPort = nextPort();
      const cid = dockerRun(tag, hostPort, envPort);
      runningContainers.push(cid);

      const ok = waitForHttp(`http://localhost:${hostPort}/`, 10_000);
      if (!ok) {
        const logs = spawnSync("docker", ["logs", cid], { encoding: "utf8", timeout: 5000 });
        throw new Error(`Express server did not respond on PORT=${envPort}.\nLogs:\n${logs.stdout}\n${logs.stderr}`);
      }
      expect(containerRunning(cid)).toBe(true);
    }, TIMEOUT_MS);
  }
);
