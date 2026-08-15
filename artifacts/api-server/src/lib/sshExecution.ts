/**
 * SSH-based remote code execution.
 *
 * Syncs project files to the remote server via SFTP, then runs the
 * appropriate interpreter over an SSH exec channel.
 */

import { Client as SshClient, type ConnectConfig } from "ssh2";
import { createHash } from "crypto";
import type { ProjectFile } from "@workspace/db";
import { buildShellEnvPrefix, buildBase64EnvSetup } from "./envCrypto";

export interface SshServerConfig {
  host: string;
  port: number;
  username: string;
  password?: string | null;
  privateKey?: string | null;
}

const REMOTE_BASE = "~/.clownin";
const EXEC_TIMEOUT_MS = 15_000;

/** Build the SSH ConnectConfig from a server row. */
function connectConfig(srv: SshServerConfig): ConnectConfig {
  const cfg: ConnectConfig = {
    host: srv.host,
    port: srv.port,
    username: srv.username,
    readyTimeout: 10_000,
    keepaliveInterval: 5_000,
  };
  if (srv.privateKey) {
    cfg.privateKey = srv.privateKey;
  } else if (srv.password) {
    cfg.password = srv.password;
  }
  return cfg;
}

/** Open a connection; resolves with a connected SshClient. */
function openConnection(srv: SshServerConfig): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    conn.on("ready", () => resolve(conn));
    conn.on("error", reject);
    conn.connect(connectConfig(srv));
  });
}

/**
 * Test that we can connect to the server.
 * Resolves on success, rejects with an error message on failure.
 */
export async function testSshConnection(srv: SshServerConfig): Promise<void> {
  const conn = await openConnection(srv);
  conn.end();
}

function getRemoteCommand(language: string, filePath: string, absDir?: string): string | null {
  switch (language) {
    case "javascript":
    case "js":
      return `node "${filePath}"`;
    case "typescript":
    case "ts":
      // bun preferred; fall back to npx tsx if unavailable
      return `bun run "${filePath}" 2>/dev/null || npx tsx "${filePath}"`;
    case "python":
    case "python3":
    case "py":
      // Use the project-local venv interpreter if available so that packages
      // installed by pip install -r requirements.txt are on sys.path.
      if (absDir) {
        return `{ [ -f "${absDir}/.venv/bin/python3" ] && "${absDir}/.venv/bin/python3" "${filePath}" || python3 "${filePath}"; }`;
      }
      return `python3 "${filePath}"`;
    case "bash":
    case "sh":
      return `bash "${filePath}"`;
    default:
      return null;
  }
}

/**
 * Build a shell script that checks whether npm packages / pip packages need
 * installing on the remote host, and runs the install tool if so.
 *
 * Uses a hash of the manifest content (computed locally) that is embedded in
 * the script and compared to a stored hash file on the remote machine.
 * Returns null when no dependency manifest was found.
 */
function buildRemoteInstallScript(absDir: string, files: ProjectFile[]): string | null {
  const parts: string[] = [];

  const pkgFile = files.find((f) => f.path === "package.json");
  if (pkgFile) {
    const hash = createHash("sha256").update(pkgFile.content, "utf8").digest("hex");
    // hex chars are A-Za-z0-9 only — safe unquoted inside double-quoted shell strings
    parts.push(
      `stored_npm=$(cat "${absDir}/.clownin-npm-hash" 2>/dev/null || echo ''); ` +
      `if [ "${hash}" != "$stored_npm" ] || [ ! -d "${absDir}/node_modules" ]; then ` +
        `echo "[Installing npm packages...]"; ` +
        `npm install --prefix "${absDir}" --prefer-offline 2>&1; ` +
        `echo "${hash}" > "${absDir}/.clownin-npm-hash"; ` +
      `fi`
    );
  }

  const reqFile = files.find((f) => f.path === "requirements.txt");
  if (reqFile) {
    const hash = createHash("sha256").update(reqFile.content, "utf8").digest("hex");
    parts.push(
      `stored_pip=$(cat "${absDir}/.clownin-pip-hash" 2>/dev/null || echo ''); ` +
      `if [ "${hash}" != "$stored_pip" ] || [ ! -d "${absDir}/.venv" ]; then ` +
        `echo "[Creating Python virtual environment...]"; ` +
        `python3 -m venv "${absDir}/.venv" 2>&1; ` +
        `echo "[Installing pip packages...]"; ` +
        `"${absDir}/.venv/bin/pip" install --quiet -r "${absDir}/requirements.txt" 2>&1; ` +
        `echo "${hash}" > "${absDir}/.clownin-pip-hash"; ` +
      `fi`
    );
  }

  return parts.length > 0 ? parts.join(" && ") : null;
}

/** Run a shell install script over an existing SSH connection, streaming output line-by-line. */
function runRemoteInstall(
  conn: SshClient,
  script: string,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    conn.exec(script, (err, stream) => {
      if (err) { onLine(`[Install skipped: ${err.message}]`); resolve(); return; }
      let buf = "";
      const emit = (d: Buffer) => {
        buf += d.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) { if (line) onLine(line); }
      };
      stream.on("data", emit);
      stream.stderr?.on("data", emit);
      stream.on("close", () => {
        if (buf) onLine(buf);
        resolve();
      });
    });
  });
}

/**
 * Upload all project files to ~/clownin/<projectId>/ on the remote server
 * using SFTP, then execute the target file and return buffered output.
 * Used by the agent's runProcess helper.
 */
export function runRemoteProcess(
  srv: SshServerConfig,
  projectId: number,
  files: ProjectFile[],
  targetPath: string,
  language: string,
  timeoutMs = EXEC_TIMEOUT_MS,
  envVars?: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise(async (resolve) => {
    let conn: SshClient;
    try {
      conn = await openConnection(srv);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({ stdout: "", stderr: `SSH connect failed: ${msg}`, exitCode: -1 });
      return;
    }

    const remoteDir = `${REMOTE_BASE}/${projectId}`;

    // 1) SFTP: ensure directory exists and upload all files
    conn.sftp((sftpErr, sftp) => {
      if (sftpErr) {
        conn.end();
        resolve({ stdout: "", stderr: `SFTP init failed: ${sftpErr.message}`, exitCode: -1 });
        return;
      }

      const ensureDir = (dir: string) =>
        new Promise<void>((res, rej) =>
          sftp.mkdir(dir, (e) => (e && (e as NodeJS.ErrnoException).code !== "EEXIST" ? rej(e) : res()))
        );

      const uploadFile = (remotePath: string, content: string) =>
        new Promise<void>((res, rej) => {
          const stream = sftp.createWriteStream(remotePath);
          stream.on("close", res);
          stream.on("error", rej);
          stream.end(Buffer.from(content, "utf8"));
        });

      (async () => {
        try {
          await ensureDir(REMOTE_BASE.replace("~", `/home/${srv.username}`));
          const absDir = remoteDir.replace("~", `/home/${srv.username}`);
          await ensureDir(absDir);

          for (const f of files) {
            // Ensure subdirectories exist for files in sub-folders
            const parts = f.path.split("/");
            for (let i = 1; i < parts.length; i++) {
              const sub = [absDir, ...parts.slice(0, i)].join("/");
              await ensureDir(sub);
            }
            await uploadFile(`${absDir}/${f.path}`, f.content);
          }

          const remoteFile = `${absDir}/${targetPath}`;
          const cmd = getRemoteCommand(language, remoteFile);
          if (!cmd) {
            sftp.end();
            conn.end();
            resolve({ stdout: "", stderr: `Unsupported language: ${language}`, exitCode: -1 });
            return;
          }

          sftp.end();

          // 2) Execute — env vars are injected as a shell prefix (KEY='val' ...)
          const envPrefix = buildShellEnvPrefix(envVars ?? {});
          conn.exec(`cd "${absDir}" && ${envPrefix}${cmd}`, (execErr, stream) => {
            if (execErr) {
              conn.end();
              resolve({ stdout: "", stderr: `Exec failed: ${execErr.message}`, exitCode: -1 });
              return;
            }

            let stdout = "";
            let stderr = "";

            const timer = setTimeout(() => {
              stream.close();
              stderr += `\n[Timed out after ${timeoutMs / 1000}s]`;
            }, timeoutMs);

            stream.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
            stream.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
            stream.on("close", (code: number) => {
              clearTimeout(timer);
              conn.end();
              resolve({ stdout, stderr, exitCode: code ?? -1 });
            });
          });
        } catch (err: unknown) {
          sftp.end();
          conn.end();
          const msg = err instanceof Error ? err.message : String(err);
          resolve({ stdout: "", stderr: `Remote setup failed: ${msg}`, exitCode: -1 });
        }
      })();
    });
  });
}

/**
 * Streaming variant for the execute SSE endpoint.
 * Calls onStdout / onStderr as data arrives, calls onExit when done.
 * onStreamReady is called with a writeStdin function once the SSH exec channel
 * is open — the caller can store it to forward stdin from the client.
 */
/**
 * Upload project files to a remote server and start a long-lived server
 * process in the background (nohup). Returns the remote PID so the caller
 * can later call stopSshServerBackground to kill it.
 */
export async function startSshServerBackground(
  srv: SshServerConfig,
  projectId: number,
  files: ProjectFile[],
  targetPath: string,
  language: string,
  port: number,
  envVars?: Record<string, string>,
): Promise<number> {
  const conn = await openConnection(srv);
  const remoteDir = `${REMOTE_BASE}/${projectId}`;

  return new Promise((resolve, reject) => {
    conn.sftp((sftpErr, sftp) => {
      if (sftpErr) { conn.end(); reject(new Error(`SFTP init failed: ${sftpErr.message}`)); return; }

      const ensureDir = (dir: string) =>
        new Promise<void>((res, rej) =>
          sftp.mkdir(dir, (e) => (e && (e as NodeJS.ErrnoException).code !== "EEXIST" ? rej(e) : res()))
        );
      const uploadFile = (remotePath: string, content: string) =>
        new Promise<void>((res, rej) => {
          const s = sftp.createWriteStream(remotePath);
          s.on("close", res); s.on("error", rej);
          s.end(Buffer.from(content, "utf8"));
        });

      (async () => {
        try {
          const absDir = remoteDir.replace("~", `/home/${srv.username}`);
          await ensureDir(REMOTE_BASE.replace("~", `/home/${srv.username}`));
          await ensureDir(absDir);
          for (const f of files) {
            const parts = f.path.split("/");
            for (let i = 1; i < parts.length; i++) {
              await ensureDir([absDir, ...parts.slice(0, i)].join("/"));
            }
            await uploadFile(`${absDir}/${f.path}`, f.content);
          }
          sftp.end();

          const remoteFile = `${absDir}/${targetPath}`;
          const cmd = getRemoteCommand(language, remoteFile, absDir);
          if (!cmd) { conn.end(); reject(new Error(`Unsupported language: ${language}`)); return; }

          const logFile = `/tmp/clownin-serve-${projectId}.log`;
          // Env vars are injected via base64 decoding inside the sh -c '...' argument.
          // Base64 chars (A-Za-z0-9+/=) are safe inside single-quoted shell strings,
          // avoiding all quoting conflicts while leaving no persistent file on the remote.
          // Values are only in memory for the lifetime of the server process.
          const envSetup = buildBase64EnvSetup(envVars ?? {});
          // cd first so the server's cwd is the project dir (relative asset paths work);
          // then decode env vars in-memory; then exec replaces sh with the server process.
          const shellCmd =
            `nohup sh -c 'cd "${absDir}" && ${envSetup}exec env PORT=${port} ${cmd}' </dev/null >"${logFile}" 2>&1 & echo $!`;

          conn.exec(shellCmd, (execErr, stream) => {
            if (execErr) { conn.end(); reject(new Error(`Exec failed: ${execErr.message}`)); return; }
            let pidStr = "";
            stream.on("data", (d: Buffer) => { pidStr += d.toString("utf8"); });
            stream.stderr?.on("data", () => {}); // drain
            stream.on("close", () => {
              conn.end();
              const pid = parseInt(pidStr.trim(), 10);
              if (isNaN(pid)) reject(new Error("Failed to read server PID"));
              else resolve(pid);
            });
          });
        } catch (err: unknown) {
          sftp.end(); conn.end();
          reject(new Error(err instanceof Error ? err.message : String(err)));
        }
      })();
    });
  });
}

/**
 * Kill a background server process on the remote server. Best-effort.
 */
/**
 * Open an SSH connection and tail the serve log file for a background server.
 * Calls onLine for each line of output, and onDone(exitCode) when the tail
 * process exits (meaning the server crashed or the log file was removed).
 *
 * Waits up to 10 s for the log file to appear before starting the tail.
 * Returns a kill() function that terminates the tail session.
 */
/**
 * Create a local TCP server on `port` that forwards every connection
 * through an SSH exec channel to the same port on the remote host.
 * This makes an SSH-hosted server reachable at localhost:port on the API server,
 * allowing the same HTTPS proxy URL to work for both local and SSH projects.
 *
 * Returns a kill() that closes the TCP server and SSH connection.
 */
export function startSshTunnel(
  srv: SshServerConfig,
  port: number,
): Promise<() => void> {
  return new Promise(async (resolve, reject) => {
    let conn: SshClient;
    try {
      conn = await openConnection(srv);
    } catch (err) {
      reject(err);
      return;
    }

    const { createServer: createTcpServer } = await import("net");
    const tcpServer = createTcpServer((socket) => {
      conn.forwardOut("127.0.0.1", port, "127.0.0.1", port, (err, channel) => {
        if (err) { socket.destroy(); return; }
        socket.pipe(channel);
        channel.pipe(socket);
        const cleanup = () => { try { channel.destroy(); } catch { /* ok */ } };
        socket.on("close", cleanup);
        socket.on("error", cleanup);
        channel.on("close", () => { try { socket.destroy(); } catch { /* ok */ } });
        channel.on("error", () => { try { socket.destroy(); } catch { /* ok */ } });
      });
    });

    tcpServer.listen(port, "127.0.0.1", () => {
      resolve(() => {
        tcpServer.close();
        conn.end();
      });
    });
    tcpServer.on("error", (err) => {
      conn.end();
      reject(err);
    });
  });
}

/**
 * Open a persistent SSH command that exits only when the remote process dies.
 * Calls onExit() when the monitored PID is no longer running.
 * Returns a kill() to cancel monitoring.
 */
export function startSshPidMonitor(
  srv: SshServerConfig,
  pid: number,
  onExit: () => void,
): Promise<() => void> {
  return new Promise(async (resolve, reject) => {
    let conn: SshClient;
    try {
      conn = await openConnection(srv);
    } catch (err) {
      reject(err);
      return;
    }

    // Loop until kill -0 fails (process has exited), then return.
    conn.exec(`while kill -0 ${pid} 2>/dev/null; do sleep 2; done`, (execErr, stream) => {
      if (execErr) { conn.end(); reject(execErr); return; }
      stream.resume();
      stream.stderr?.resume();
      stream.on("close", () => { conn.end(); onExit(); });
      resolve(() => {
        try { stream.close(); } catch { /* ok */ }
        conn.end();
      });
    });
  });
}

export function startSshLogTail(
  srv: SshServerConfig,
  projectId: number,
  onLine: (line: string) => void,
  onDone: (code: number | null) => void,
): Promise<() => void> {
  return new Promise(async (resolve, reject) => {
    let conn: SshClient;
    try {
      conn = await openConnection(srv);
    } catch (err: unknown) {
      reject(err);
      return;
    }

    const logFile = `/tmp/clownin-serve-${projectId}.log`;
    // Wait up to 10 s for the log file to exist, then follow it continuously.
    // tail -F (capital F) retries if the file is recreated.
    const shellCmd =
      `timeout=10; elapsed=0; ` +
      `while [ ! -f "${logFile}" ] && [ "$elapsed" -lt "$timeout" ]; do sleep 0.5; elapsed=$((elapsed+1)); done; ` +
      `tail -F "${logFile}" 2>/dev/null`;

    conn.exec(shellCmd, (execErr, stream) => {
      if (execErr) {
        conn.end();
        reject(execErr);
        return;
      }

      let buf = "";
      stream.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line) onLine(line);
        }
      });
      stream.stderr?.on("data", () => {}); // drain stderr silently
      stream.on("close", (code: number | null) => {
        conn.end();
        if (buf) onLine(buf); // flush any partial last line
        onDone(code);
      });

      // Expose a kill function so the caller can terminate the tail cleanly.
      resolve(() => {
        try { stream.close(); } catch { /* already closed */ }
        conn.end();
      });
    });
  });
}

/**
 * Wipe node_modules, .venv, and cached install hashes from the remote project
 * directory so the next run reinstalls packages from scratch. Best-effort.
 */
export async function cleanRemotePackages(
  srv: SshServerConfig,
  projectId: number,
): Promise<void> {
  let conn: SshClient;
  try { conn = await openConnection(srv); }
  catch { return; }
  const absDir = `${REMOTE_BASE}/${projectId}`.replace("~", `/home/${srv.username}`);
  return new Promise((resolve) => {
    conn.exec(
      `rm -rf "${absDir}/node_modules" "${absDir}/.venv" "${absDir}/.clownin-npm-hash" "${absDir}/.clownin-pip-hash"`,
      (err, stream) => {
        if (err) { conn.end(); resolve(); return; }
        stream.resume();
        stream.stderr?.resume();
        stream.on("close", () => { conn.end(); resolve(); });
      },
    );
  });
}

export async function stopSshServerBackground(
  srv: SshServerConfig,
  pid: number,
): Promise<void> {
  let conn: SshClient;
  try { conn = await openConnection(srv); }
  catch { return; } // can't connect — nothing to do
  return new Promise((resolve) => {
    conn.exec(`kill ${pid} 2>/dev/null; sleep 1; kill -9 ${pid} 2>/dev/null; true`, (err, stream) => {
      if (err) { conn.end(); resolve(); return; }
      stream.resume(); stream.stderr?.resume();
      stream.on("close", () => { conn.end(); resolve(); });
    });
  });
}

export function streamRemoteProcess(
  srv: SshServerConfig,
  projectId: number,
  files: ProjectFile[],
  targetPath: string,
  language: string,
  handlers: {
    onStreamReady?: (writeStdin: (data: string) => boolean) => void;
    /** System-phase output (install logs). Falls back to onStdout if not provided. */
    onSystem?: (chunk: string) => void;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
    onExit: (code: number) => void;
    onError: (msg: string) => void;
  },
  signal?: { aborted: boolean },
  envVars?: Record<string, string>
): void {
  const { onStdout, onStderr, onExit, onError } = handlers;

  (async () => {
    let conn: SshClient;
    try {
      conn = await openConnection(srv);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onError(`SSH connect failed: ${msg}`);
      return;
    }

    if (signal?.aborted) { conn.end(); return; }

    const remoteDir = `${REMOTE_BASE}/${projectId}`;

    conn.sftp((sftpErr, sftp) => {
      if (sftpErr) {
        conn.end();
        onError(`SFTP init failed: ${sftpErr.message}`);
        return;
      }

      const ensureDir = (dir: string) =>
        new Promise<void>((res, rej) =>
          sftp.mkdir(dir, (e) => (e && (e as NodeJS.ErrnoException).code !== "EEXIST" ? rej(e) : res()))
        );

      const uploadFile = (remotePath: string, content: string) =>
        new Promise<void>((res, rej) => {
          const stream = sftp.createWriteStream(remotePath);
          stream.on("close", res);
          stream.on("error", rej);
          stream.end(Buffer.from(content, "utf8"));
        });

      (async () => {
        try {
          const absDir = remoteDir.replace("~", `/home/${srv.username}`);
          await ensureDir(REMOTE_BASE.replace("~", `/home/${srv.username}`));
          await ensureDir(absDir);

          for (const f of files) {
            const parts = f.path.split("/");
            for (let i = 1; i < parts.length; i++) {
              const sub = [absDir, ...parts.slice(0, i)].join("/");
              await ensureDir(sub);
            }
            await uploadFile(`${absDir}/${f.path}`, f.content);
          }

          const remoteFile = `${absDir}/${targetPath}`;
          const cmd = getRemoteCommand(language, remoteFile, absDir);
          if (!cmd) {
            sftp.end();
            conn.end();
            onError(`Unsupported language: ${language}`);
            return;
          }

          sftp.end();

          if (signal?.aborted) { conn.end(); return; }

          // ── Remote install step (npm / pip) ───────────────────────────────
          // Runs before the main exec so packages are available at runtime.
          // Output streams as "system" events (grey in the terminal).
          const installScript = buildRemoteInstallScript(absDir, files);
          if (installScript) {
            const onSystemLine = handlers.onSystem ?? handlers.onStdout;
            await runRemoteInstall(conn, installScript, onSystemLine);
            if (signal?.aborted) { conn.end(); return; }
          }

          const envPrefix = buildShellEnvPrefix(envVars ?? {});
          conn.exec(`cd "${absDir}" && ${envPrefix}${cmd}`, (execErr, stream) => {
            if (execErr) {
              conn.end();
              onError(`Exec failed: ${execErr.message}`);
              return;
            }

            // Track stream-level errors so writeStdin can report viability.
            // Registering this listener prevents unhandled-error process crash.
            let streamErrored = false;
            stream.on("error", () => { streamErrored = true; });

            // Expose stdin write — returns false when the channel has errored
            // or the underlying write fails.
            handlers.onStreamReady?.((data: string): boolean => {
              if (streamErrored) return false;
              try {
                stream.write(data);
                return true;
              } catch {
                streamErrored = true;
                return false;
              }
            });

            const timer = setTimeout(() => {
              stream.close();
              onStderr("\n[Execution timed out after 15 seconds]");
            }, EXEC_TIMEOUT_MS);

            if (signal?.aborted) { stream.close(); conn.end(); return; }

            stream.on("data", (d: Buffer) => onStdout(d.toString("utf8")));
            stream.stderr.on("data", (d: Buffer) => onStderr(d.toString("utf8")));
            stream.on("close", (code: number) => {
              clearTimeout(timer);
              conn.end();
              onExit(code ?? -1);
            });
          });
        } catch (err: unknown) {
          sftp.end();
          conn.end();
          const msg = err instanceof Error ? err.message : String(err);
          onError(`Remote setup failed: ${msg}`);
        }
      })();
    });
  })();
}
