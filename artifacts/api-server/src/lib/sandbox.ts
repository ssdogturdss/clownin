/**
 * Docker-backed runtime for untrusted local previews.
 *
 * Preview code runs in a network-less, read-only container. The API reaches
 * its loopback-only server through a host-owned Unix-socket broker. The broker
 * socket is mounted read-only in the container, so preview code cannot rename,
 * replace, or retarget the endpoint the host connects to.
 */
import { spawn, type ChildProcess } from "child_process";
import { chmod, mkdir, rm } from "fs/promises";
import net from "net";
import { Duplex } from "stream";
import { Agent } from "http";
import { join } from "path";
import { tmpdir } from "os";

export type SandboxRuntime = "node" | "bun" | "python";
type RuntimeSpec = {
  image: string;
  dockerfile: string;
  executable: string;
};

const RUNTIMES: Record<SandboxRuntime, RuntimeSpec> = {
  node: {
    image: "clownin-preview-node:3",
    dockerfile: "Dockerfile.node",
    executable: "/usr/local/bin/node",
  },
  bun: {
    image: "clownin-preview-bun:3",
    dockerfile: "Dockerfile.bun",
    executable: "/usr/local/bin/bun",
  },
  python: {
    image: "clownin-preview-python:3",
    dockerfile: "Dockerfile.python",
    executable: "/usr/local/bin/python3",
  },
};

const SANDBOX_PORT = 3000;
const MAX_FRAME_BYTES = 1024 * 1024;
const FRAME_OPEN = 1;
const FRAME_DATA = 2;
const FRAME_END = 3;
const imageReady = new Map<SandboxRuntime, Promise<void>>();

function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `docker ${args[0]} exited with code ${code ?? -1}`));
    });
  });
}

class SandboxStream extends Duplex {
  constructor(private readonly broker: SandboxBroker, readonly streamId: number) {
    super();
  }

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const payload = Buffer.from(chunk);
      for (let offset = 0; offset < payload.length; offset += MAX_FRAME_BYTES) {
        this.broker.send(FRAME_DATA, this.streamId, payload.subarray(offset, offset + MAX_FRAME_BYTES));
      }
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    try {
      this.broker.send(FRAME_END, this.streamId);
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _destroy(_error: Error | null, callback: (error?: Error | null) => void): void {
    this.broker.drop(this.streamId);
    callback();
  }

  // http.request expects these net.Socket methods on its custom transport.
  setTimeout(): this { return this; }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

/**
 * Host-owned multiplexed reverse broker.
 * The container is only a client of this socket, and the mounted socket path
 * is read-only from inside the container.
 */
export class SandboxBroker {
  private connection: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private nextStreamId = 1;
  private readonly streams = new Map<number, SandboxStream>();
  private readonly connected: Promise<void>;
  private resolveConnected!: () => void;

  private constructor(
    private readonly server: net.Server,
    readonly dir: string,
    readonly socketPath: string,
  ) {
    this.connected = new Promise((resolve) => { this.resolveConnected = resolve; });
    server.on("connection", (connection) => this.accept(connection));
  }

  static async create(name: string): Promise<SandboxBroker> {
    const dir = join(tmpdir(), "clownin-preview-brokers", name);
    const socketPath = join(dir, "broker.sock");
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await chmod(dir, 0o755);
    const server = net.createServer();
    const broker = new SandboxBroker(server, dir, socketPath);

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        void chmod(socketPath, 0o666).then(resolve, reject);
      });
    });
    return broker;
  }

  async waitUntilConnected(): Promise<void> {
    await Promise.race([
      this.connected,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Preview relay did not connect")), 5_000);
        timer.unref();
      }),
    ]);
  }

  createStream(): SandboxStream {
    if (!this.connection?.writable) throw new Error("Preview relay is not connected");
    const stream = new SandboxStream(this, this.nextStreamId++);
    this.streams.set(stream.streamId, stream);
    this.send(FRAME_OPEN, stream.streamId);
    queueMicrotask(() => stream.emit("connect"));
    return stream;
  }

  isConnected(): boolean {
    return Boolean(this.connection?.writable);
  }

  /** Creates a one-use HTTP agent whose connection is this broker, not TCP. */
  createHttpAgent(): Agent {
    const broker = this;
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = function createConnection(_options, callback) {
      try {
        const stream = broker.createStream();
        if (callback) queueMicrotask(() => callback(null, stream as unknown as net.Socket));
        return stream as unknown as net.Socket;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (callback) {
          queueMicrotask(() => callback(error, undefined as unknown as net.Socket));
          return undefined as unknown as net.Socket;
        }
        throw error;
      }
    };
    return agent;
  }

  send(type: number, streamId: number, payload = Buffer.alloc(0)): void {
    if (!this.connection?.writable) throw new Error("Preview relay disconnected");
    if (payload.length > MAX_FRAME_BYTES) throw new Error("Preview relay frame too large");
    const header = Buffer.allocUnsafe(9);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(streamId, 1);
    header.writeUInt32BE(payload.length, 5);
    this.connection.write(Buffer.concat([header, payload]));
  }

  drop(streamId: number): void {
    this.streams.delete(streamId);
  }

  close(): void {
    this.connection?.destroy();
    this.server.close();
    for (const stream of this.streams.values()) stream.destroy();
    this.streams.clear();
    void rm(this.dir, { recursive: true, force: true });
  }

  private accept(connection: net.Socket): void {
    if (this.connection) {
      connection.destroy();
      return;
    }
    this.connection = connection;
    connection.on("data", (chunk) => this.receive(Buffer.from(chunk)));
    connection.on("error", () => this.disconnect());
    connection.on("close", () => this.disconnect());
    this.resolveConnected();
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 9) {
      const type = this.buffer.readUInt8(0);
      const streamId = this.buffer.readUInt32BE(1);
      const length = this.buffer.readUInt32BE(5);
      if (length > MAX_FRAME_BYTES) {
        this.disconnect();
        return;
      }
      if (this.buffer.length < 9 + length) return;
      const payload = this.buffer.subarray(9, 9 + length);
      this.buffer = this.buffer.subarray(9 + length);
      const stream = this.streams.get(streamId);
      if (!stream) continue;
      if (type === FRAME_DATA) stream.push(payload);
      else if (type === FRAME_END) {
        this.streams.delete(streamId);
        stream.push(null);
      }
    }
  }

  private disconnect(): void {
    const connection = this.connection;
    this.connection = null;
    connection?.destroy();
    for (const stream of this.streams.values()) {
      stream.destroy(new Error("Preview relay disconnected"));
    }
    this.streams.clear();
  }
}

async function ensureSandboxImage(runtime: SandboxRuntime): Promise<void> {
  const spec = RUNTIMES[runtime];
  let ready = imageReady.get(runtime);
  if (!ready) {
    ready = (async () => {
      try {
        await runDocker(["image", "inspect", spec.image]);
      } catch {
        await runDocker([
          "build",
          "--tag", spec.image,
          "--file", join(__dirname, "sandbox", spec.dockerfile),
          join(__dirname, "sandbox"),
        ]);
      }
    })().catch((err) => {
      imageReady.delete(runtime);
      throw err;
    });
    imageReady.set(runtime, ready);
  }
  return ready;
}

export type SandboxServer = {
  containerId: string;
  port: number;
  broker: SandboxBroker;
};

export async function startSandboxServer(options: {
  projectDir: string;
  runtime: SandboxRuntime;
  args: string[];
  env: NodeJS.ProcessEnv;
}): Promise<SandboxServer> {
  const spec = RUNTIMES[options.runtime];
  await ensureSandboxImage(options.runtime);
  const name = `clownin-preview-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const broker = await SandboxBroker.create(name);
  const envArgs = Object.entries(options.env)
    .filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" &&
      !["PATH", "HOME", "TMPDIR", "PORT", "PYTHONPATH", "PYTHONHOME"].includes(entry[0]),
    )
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);

  try {
    const { stdout } = await runDocker([
      "run", "--detach", "--rm", "--name", name,
      "--network", "none",
      "--read-only",
      "--user", "65534:65534",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "64",
      "--memory", "384m",
      "--memory-swap", "384m",
      "--cpus", "0.50",
      "--ulimit", "nofile=256:256",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m",
      "--tmpfs", "/run:rw,nosuid,nodev,noexec,size=16m",
      "--mount", `type=bind,src=${options.projectDir},dst=/workspace,readonly`,
      "--mount", `type=bind,src=${broker.dir},dst=/relay,readonly`,
      "--workdir", "/workspace",
      "--env", "PATH=/usr/local/bin:/usr/bin:/bin",
      "--env", "HOME=/tmp",
      "--env", `PORT=${SANDBOX_PORT}`,
      "--env", "SANDBOX_BROKER_SOCKET=/relay/broker.sock",
      ...envArgs,
      spec.image,
      spec.executable,
      ...options.args,
    ]);
    const containerId = stdout.trim();
    try {
      await broker.waitUntilConnected();
    } catch (err) {
      stopSandbox(containerId, broker);
      throw err;
    }
    return { containerId, port: SANDBOX_PORT, broker };
  } catch (err) {
    broker.close();
    throw err;
  }
}

export function followSandboxLogs(containerId: string): ChildProcess {
  return spawn("docker", ["logs", "--follow", containerId], { stdio: "pipe" });
}

export function waitForSandboxExit(containerId: string): ChildProcess {
  return spawn("docker", ["wait", containerId], { stdio: "pipe" });
}

export function stopSandbox(containerId: string, broker: SandboxBroker): void {
  const child = spawn("docker", ["rm", "--force", containerId], { stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  broker.close();
}

export function cleanupSandboxBroker(broker: SandboxBroker): void {
  broker.close();
}