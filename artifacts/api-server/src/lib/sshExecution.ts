/**
 * SSH-based remote code execution.
 *
 * Syncs project files to the remote server via SFTP, then runs the
 * appropriate interpreter over an SSH exec channel.
 */

import { Client as SshClient, type ConnectConfig } from "ssh2";
import type { ProjectFile } from "@workspace/db";

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

function getRemoteCommand(language: string, filePath: string): string | null {
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
      return `python3 "${filePath}"`;
    case "bash":
    case "sh":
      return `bash "${filePath}"`;
    default:
      return null;
  }
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
  timeoutMs = EXEC_TIMEOUT_MS
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

          // 2) Execute
          conn.exec(`cd "${absDir}" && ${cmd}`, (execErr, stream) => {
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
export function streamRemoteProcess(
  srv: SshServerConfig,
  projectId: number,
  files: ProjectFile[],
  targetPath: string,
  language: string,
  handlers: {
    onStreamReady?: (writeStdin: (data: string) => boolean) => void;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
    onExit: (code: number) => void;
    onError: (msg: string) => void;
  },
  signal?: { aborted: boolean }
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
          const cmd = getRemoteCommand(language, remoteFile);
          if (!cmd) {
            sftp.end();
            conn.end();
            onError(`Unsupported language: ${language}`);
            return;
          }

          sftp.end();

          if (signal?.aborted) { conn.end(); return; }

          conn.exec(`cd "${absDir}" && ${cmd}`, (execErr, stream) => {
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
