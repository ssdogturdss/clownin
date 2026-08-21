/**
 * SSH-based remote code execution.
 *
 * Syncs project files to the remote server via SFTP, then runs the
 * appropriate interpreter over an SSH exec channel.
 */

import { Client as SshClient, type ConnectConfig, type SFTPWrapper } from "ssh2";
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
const PGID_DISCOVERY_GRACE_MS = 1_000;

export function buildRemoteProcessGroupStopCommand(pgid: number): string {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) {
    throw new Error("Invalid remote process group");
  }
  // A negative PID targets the process group. TERM gives HTTP servers a chance
  // to close cleanly; KILL handles children that ignore it.
  return `if kill -0 -${pgid} 2>/dev/null; then kill -TERM -${pgid} 2>/dev/null; sleep 1; kill -KILL -${pgid} 2>/dev/null || true; fi`;
}

/**
 * Coordinates cancellation when the remote process-group ID arrives after the
 * executable SSH channel is already available. Closing that channel immediately
 * stops output, while the process-group kill is deferred until its ID is known.
 */
export function createRemoteProcessAborter(
  stopProcessGroup: (pgid: number) => void,
  closeStream: () => void,
  pgidDiscoveryGraceMs = PGID_DISCOVERY_GRACE_MS,
): { abort: () => void; setProcessGroup: (pgid: number) => void; dispose: () => void } {
  let pgid: number | null = null;
  let abortRequested = false;
  let streamCloseStarted = false;
  let processGroupStopStarted = false;
  let fallbackTimer: NodeJS.Timeout | null = null;

  const stopProcessGroupIfReady = () => {
    if (pgid === null || processGroupStopStarted) return;
    processGroupStopStarted = true;
    stopProcessGroup(pgid);
  };

  const closeStreamOnce = () => {
    if (streamCloseStarted) return;
    streamCloseStarted = true;
    closeStream();
  };

  const clearFallbackTimer = () => {
    if (!fallbackTimer) return;
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  };

  return {
    abort: () => {
      abortRequested = true;
      stopProcessGroupIfReady();
      if (pgid !== null) {
        closeStreamOnce();
        return;
      }
      // The PGID marker is emitted on this stream's stderr. Keep the stream
      // open briefly after cancellation so a marker already in flight can be
      // consumed and its detached process group can still be killed.
      if (!fallbackTimer) {
        fallbackTimer = setTimeout(closeStreamOnce, pgidDiscoveryGraceMs);
      }
    },
    setProcessGroup: (nextPgid: number) => {
      pgid = nextPgid;
      if (abortRequested) {
        clearFallbackTimer();
        stopProcessGroupIfReady();
        closeStreamOnce();
      }
    },
    dispose: clearFallbackTimer,
  };
}

function base64Shell(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `sh -c "$(printf %s '${encoded}' | base64 -d)"`;
}

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
 * Create a remote directory if needed. Some SFTP servers report an existing
 * directory as a generic "Failure" rather than EEXIST, so verify it after a
 * failed mkdir instead of trusting the error code.
 */
function ensureRemoteDirectory(sftp: SFTPWrapper, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.stat(dir, (statErr) => {
      if (!statErr) {
        resolve();
        return;
      }
      sftp.mkdir(dir, (mkdirErr) => {
        if (!mkdirErr) {
          resolve();
          return;
        }
        // A competing setup or an SFTP implementation without an EEXIST code
        // may have created the directory. Confirm before treating it as fatal.
        sftp.stat(dir, (verifyErr) => {
          if (verifyErr) reject(mkdirErr);
          else resolve();
        });
      });
    });
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
    case "go":
      return `go run "${filePath}"`;
    case "ruby":
    case "rb":
      return `ruby "${filePath}"`;
    case "rust":
    case "rs":
      return `rustc "${filePath}" -o "${filePath}.bin" && "${filePath}.bin"`;
    case "java": {
      const dir = absDir ?? filePath.replace(/\/[^/]+$/, "");
      const className = filePath.replace(/.*\/([^/]+)\.java$/, "$1");
      return `javac "${filePath}" && java -cp "${dir}" "${className}"`;
    }
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

      const ensureDir = (dir: string) => ensureRemoteDirectory(sftp, dir);

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

      const ensureDir = (dir: string) => ensureRemoteDirectory(sftp, dir);
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
           // Start a new session/process group. The returned PID is therefore
           // also the PGID, allowing Stop to terminate the server and every
           // child it spawned instead of leaving remote work behind.
           const program = `cd "${absDir}" && ${envSetup}exec env PORT=${port} ${cmd}`;
           const shellCmd =
             `nohup setsid ${base64Shell(program)} </dev/null >"${logFile}" 2>&1 & echo $!`;

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

    // A negative PID checks the whole process group, so descendants keep the
    // preview visible until they are actually gone.
    conn.exec(`while kill -0 -${pid} 2>/dev/null; do sleep 2; done`, (execErr, stream) => {
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
): Promise<boolean> {
  let command: string;
  try {
    command = buildRemoteProcessGroupStopCommand(pid);
  } catch {
    return false;
  }
  let conn: SshClient;
  try { conn = await openConnection(srv); }
  catch { return false; } // can't connect — nothing to do
  return new Promise((resolve) => {
    conn.exec(command, (err, stream) => {
      if (err) { conn.end(); resolve(false); return; }
      stream.resume(); stream.stderr?.resume();
      stream.on("close", () => { conn.end(); resolve(true); });
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
    onProcessGroupReady?: (pgid: number) => void;
    /** System-phase output (install logs). Falls back to onStdout if not provided. */
    onSystem?: (chunk: string) => void;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
    onExit: (code: number) => void;
    onError: (msg: string) => void;
  },
  signal?: { aborted: boolean; onAbort?: () => void },
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
    // Until the main exec channel opens, closing the SSH connection is the
    // only process handle available. It cancels in-progress SFTP and package
    // setup when the browser disconnects instead of waiting for setup to end.
    if (signal) signal.onAbort = () => conn.end();

    const remoteDir = `${REMOTE_BASE}/${projectId}`;

    conn.sftp((sftpErr, sftp) => {
      if (sftpErr) {
        conn.end();
        onError(`SFTP init failed: ${sftpErr.message}`);
        return;
      }

      const ensureDir = (dir: string) => ensureRemoteDirectory(sftp, dir);

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
           // Emit the session leader as an internal stderr marker. The client
           // never sees this marker; it lets abort/disconnect terminate the
           // full remote process group through a separate SSH connection.
           const program =
             `printf '__CLOWNIN_PGID=%s\\n' "$$" >&2; ` +
             `cd "${absDir}" && ${envPrefix}exec ${cmd}`;
           conn.exec(`setsid ${base64Shell(program)}`, (execErr, stream) => {
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
             // or the underlying write fails. The callback is emitted once the
             // process group is known, so an explicit Stop always has a PGID
             // available to terminate rather than racing the stderr marker.
             const writeStdin = (data: string): boolean => {
              if (streamErrored) return false;
              try {
                stream.write(data);
                return true;
              } catch {
                streamErrored = true;
                return false;
              }
             };

              const remoteAborter = createRemoteProcessAborter(
                (pgid) => { void stopSshServerBackground(srv, pgid); },
                () => { try { stream.close(); } catch { /* already closed */ } },
              );
             if (signal) signal.onAbort = remoteAborter.abort;

             const timer = setTimeout(() => {
                remoteAborter.abort();
              onStderr("\n[Execution timed out after 15 seconds]");
            }, EXEC_TIMEOUT_MS);

             stream.on("data", (d: Buffer) => onStdout(d.toString("utf8")));
             let stderrBuffer = "";
              let streamReady = false;
             stream.stderr.on("data", (d: Buffer) => {
               stderrBuffer += d.toString("utf8");
               const lines = stderrBuffer.split("\n");
               stderrBuffer = lines.pop() ?? "";
               for (const line of lines) {
                 const match = line.match(/^__CLOWNIN_PGID=(\d+)$/);
                 if (match) {
                   const candidate = Number.parseInt(match[1], 10);
                   if (Number.isSafeInteger(candidate) && candidate > 1) {
                      remoteAborter.setProcessGroup(candidate);
                     handlers.onProcessGroupReady?.(candidate);
                      if (!streamReady && !signal?.aborted) {
                        streamReady = true;
                        handlers.onStreamReady?.(writeStdin);
                      }
                   }
                 } else {
                   onStderr(`${line}\n`);
                 }
               }
             });
            stream.on("close", (code: number) => {
              clearTimeout(timer);
               remoteAborter.dispose();
               if (signal) signal.onAbort = undefined;
               if (stderrBuffer) onStderr(stderrBuffer);
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
