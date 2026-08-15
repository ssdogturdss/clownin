/**
 * Per-project persistent working directories in /tmp.
 *
 * Each project gets /tmp/clownin-projects/<id>/ where ALL its files are synced
 * before every execution. This means:
 *   - require('./utils') works across multiple files
 *   - node_modules/ from npm install persists within the server session
 *   - Python imports work across files in the same directory
 *
 * Smart install: before executing, we hash the package.json / requirements.txt
 * and only run the install tool when the hash differs or the install directory
 * is absent. This means the second run starts immediately without reinstalling.
 */
import { writeFile, mkdir, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { spawn } from "child_process";

const BASE = join(tmpdir(), "clownin-projects");
const INSTALL_TIMEOUT_MS = 120_000; // 2 minutes

export function projectDir(projectId: number): string {
  return join(BASE, String(projectId));
}

/**
 * Check whether a file list contains dependency manifests that trigger
 * automatic package installation.
 */
export function hasDepManifest(files: Array<{ path: string }>): {
  hasNpm: boolean;
  hasPip: boolean;
} {
  return {
    hasNpm: files.some((f) => f.path === "package.json"),
    hasPip: files.some((f) => f.path === "requirements.txt"),
  };
}

export async function syncProjectFiles(
  projectId: number,
  files: Array<{ path: string; content: string }>
): Promise<string> {
  const dir = projectDir(projectId);
  await mkdir(dir, { recursive: true });

  for (const f of files) {
    // Sanitise path — no escaping the project dir
    const safe = f.path.replace(/\.\.\//g, "").replace(/^\//, "");
    const abs = join(dir, safe);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content, "utf8");
  }

  return dir;
}

/**
 * Run npm install and/or pip install (into a project-local .venv) if the
 * dependency manifest has changed since the last install, or if the install
 * directory is absent.
 *
 * Install output is streamed line-by-line via `onLine`. System messages
 * (e.g. "[Installing npm packages…]") use type "system"; npm/pip stdout/stderr
 * also use "system" so they appear in the terminal's grey/italic channel.
 *
 * Always resolves — install failure is non-fatal so the user can still run
 * their code (and see the error in the terminal).
 */
export async function runInstallIfNeeded(
  projDir: string,
  files: Array<{ path: string; content: string }>,
  onLine: (type: "system" | "stderr", text: string) => void,
): Promise<void> {
  // ── npm install ─────────────────────────────────────────────────────────────
  const pkgFile = files.find((f) => f.path === "package.json");
  if (pkgFile) {
    const hash = createHash("sha256").update(pkgFile.content, "utf8").digest("hex");
    const hashFile = join(projDir, ".clownin-npm-hash");
    const nodeModules = join(projDir, "node_modules");
    let storedHash = "";
    try { storedHash = (await readFile(hashFile, "utf8")).trim(); } catch { /* first run */ }

    if (hash !== storedHash || !existsSync(nodeModules)) {
      onLine("system", "[Installing npm packages…]");
      await spawnInstall("npm", ["install", "--prefer-offline"], projDir, onLine);
      await writeFile(hashFile, hash, "utf8").catch(() => {});
    }
  }

  // ── pip install into project-local .venv ────────────────────────────────────
  const reqFile = files.find((f) => f.path === "requirements.txt");
  if (reqFile) {
    const hash = createHash("sha256").update(reqFile.content, "utf8").digest("hex");
    const hashFile = join(projDir, ".clownin-pip-hash");
    const venv = join(projDir, ".venv");
    let storedHash = "";
    try { storedHash = (await readFile(hashFile, "utf8")).trim(); } catch { /* first run */ }

    if (hash !== storedHash || !existsSync(venv)) {
      onLine("system", "[Creating Python virtual environment…]");
      await spawnInstall("python3", ["-m", "venv", ".venv"], projDir, onLine);
      onLine("system", "[Installing pip packages…]");
      await spawnInstall(
        join(venv, "bin", "pip"),
        ["install", "--quiet", "-r", "requirements.txt"],
        projDir,
        onLine,
      );
      await writeFile(hashFile, hash, "utf8").catch(() => {});
    }
  }
}

function spawnInstall(
  cmd: string,
  args: string[],
  cwd: string,
  onLine: (type: "system" | "stderr", text: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const safeEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG,
      // npm needs npm_config_cache to stay consistent; default is fine
    };

    const child = spawn(cmd, args, { cwd, env: safeEnv, stdio: "pipe" });

    let stdoutBuf = "";
    let stderrBuf = "";

    const flushLines = (buf: string, setter: (s: string) => void) => {
      const lines = buf.split("\n");
      const remaining = lines.pop() ?? "";
      setter(remaining);
      for (const line of lines) { if (line) onLine("system", line); }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      flushLines(stdoutBuf, (s) => { stdoutBuf = s; });
    });

    // npm writes progress to stderr — show it as system (grey) not red
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      flushLines(stderrBuf, (s) => { stderrBuf = s; });
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      onLine("system", "[Install timed out after 2 minutes]");
    }, INSTALL_TIMEOUT_MS);

    child.on("close", () => {
      clearTimeout(timer);
      if (stdoutBuf) onLine("system", stdoutBuf);
      if (stderrBuf) onLine("system", stderrBuf);
      resolve(); // always resolve — install failure is non-fatal
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      onLine("system", `[Install error: ${err.message}]`);
      resolve();
    });
  });
}

/**
 * Wipe installed packages so the next run reinstalls from scratch.
 * Called by POST /projects/:id/clean.
 */
export async function cleanProjectPackages(projDir: string): Promise<void> {
  await Promise.all([
    rm(join(projDir, "node_modules"), { recursive: true, force: true }),
    rm(join(projDir, ".venv"), { recursive: true, force: true }),
    rm(join(projDir, ".clownin-npm-hash"), { force: true }),
    rm(join(projDir, ".clownin-pip-hash"), { force: true }),
  ]);
}
