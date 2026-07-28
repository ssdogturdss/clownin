import { Router, type IRouter } from "express";
import { spawn } from "child_process";
import { writeFile, unlink, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { db, projectsTable, projectFilesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import OpenAI from "openai";

const router: IRouter = Router();

function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey });
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const AGENT_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all files in the project (path + language)",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full content of a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Overwrite an existing file with new content",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Create a new file (or overwrite if it already exists). Use for brand new files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          language: {
            type: "string",
            enum: ["javascript", "typescript", "python", "bash", "plaintext"],
          },
        },
        required: ["path", "content", "language"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file from the project",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_code",
      description:
        "Execute a file and return stdout/stderr. Always use this after writing code to verify it works. Fix any errors and re-run until the exit code is 0.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

// ── Execution helper (collect output, don't stream) ───────────────────────────
const EXEC_TIMEOUT_MS = 15_000;

function execCommand(
  language: string,
  filePath: string
): { cmd: string; args: string[] } | null {
  switch (language) {
    case "javascript":
    case "js":
      return { cmd: "node", args: [filePath] };
    case "typescript":
    case "ts":
      return { cmd: "bun", args: ["run", filePath] };
    case "python":
    case "python3":
    case "py":
      return { cmd: "python3", args: [filePath] };
    case "bash":
    case "sh":
      return { cmd: "bash", args: [filePath] };
    default:
      return null;
  }
}

async function runFile(
  language: string,
  content: string,
  filename: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const ext = filename.includes(".") ? filename.split(".").pop() : language;
  const tmpDir = join(tmpdir(), "clownin-agent");
  await mkdir(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, `${randomUUID()}.${ext}`);
  await writeFile(tmpFile, content, "utf8");

  const executor = execCommand(language, tmpFile);
  if (!executor) {
    await unlink(tmpFile).catch(() => {});
    return { stdout: "", stderr: `Unsupported language: ${language}`, exitCode: -1 };
  }

  return new Promise((resolve) => {
    const safeEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG,
    };

    const child = spawn(executor.cmd, executor.args, {
      timeout: EXEC_TIMEOUT_MS,
      env: safeEnv,
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += "\n[Timed out after 15 seconds]";
    }, EXEC_TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

    child.on("close", async (code) => {
      clearTimeout(timer);
      await unlink(tmpFile).catch(() => {});
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });

    child.on("error", async (err) => {
      clearTimeout(timer);
      await unlink(tmpFile).catch(() => {});
      resolve({ stdout: "", stderr: `Process error: ${err.message}`, exitCode: -1 });
    });
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────
router.post(
  "/projects/:id/agent",
  requireAuth,
  async (req, res): Promise<void> => {
    const { userId } = getUser(req);
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const projectId = parseInt(rawId, 10);

    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const { message, history } = req.body ?? {};
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    // Verify project ownership
    const [project] = await db
      .select()
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
      .limit(1);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const files = await db
      .select()
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));

    // SSE setup
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    type EvtType = "thinking" | "tool_call" | "tool_result" | "token" | "message" | "done" | "error";
    function sse(type: EvtType, payload?: unknown) {
      res.write(`data: ${JSON.stringify({ type, payload })}\n\n`);
    }

    const systemPrompt = `You are an autonomous coding agent inside Clownin — a mobile code editor.
Project: "${project.name}" | Primary language: ${project.language}

When the user asks you to build something:
1. List existing files first (list_files), then read relevant ones (read_file).
2. Write complete, working code — no TODOs, no placeholders, no "add your logic here".
3. After writing, always run_code to verify. Fix errors and re-run until exit 0.
4. Be brief in your final response: what you built + how to run it. No lengthy explanations.

Current files:
${files.length === 0 ? "(none)" : files.map((f) => `  ${f.path} (${f.language})`).join("\n")}`;

    const conversationHistory: OpenAI.ChatCompletionMessageParam[] = Array.isArray(history)
      ? history
      : [];

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
      { role: "user", content: message },
    ];

    sse("thinking");

    const openai = getOpenAI();
    const MAX_ITERATIONS = 15;
    let iteration = 0;
    let aborted = false;
    req.on("close", () => { aborted = true; });

    try {
      while (iteration < MAX_ITERATIONS && !aborted) {
        iteration++;

        const stream = await openai.chat.completions.create({
          model: "gpt-4o",
          messages,
          tools: AGENT_TOOLS,
          tool_choice: "auto",
          stream: true,
          max_tokens: 4096,
          temperature: 0.15,
        });

        let textContent = "";
        const toolCallsMap = new Map<
          number,
          { id: string; name: string; args: string }
        >();

        for await (const chunk of stream) {
          if (aborted) break;
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            textContent += delta.content;
            sse("token", delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const prev = toolCallsMap.get(tc.index) ?? { id: "", name: "", args: "" };
              toolCallsMap.set(tc.index, {
                id: prev.id || tc.id || "",
                name: prev.name || tc.function?.name || "",
                args: prev.args + (tc.function?.arguments ?? ""),
              });
            }
          }
        }

        const toolCalls = [...toolCallsMap.values()];

        if (toolCalls.length === 0) {
          if (textContent) sse("message", { text: textContent });
          sse("done");
          res.end();
          return;
        }

        // Append assistant message with tool calls
        messages.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.args },
          })),
        });

        // Execute each tool
        for (const tc of toolCalls) {
          if (aborted) break;

          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.args || "{}"); } catch { /* ignore */ }

          sse("tool_call", { tool: tc.name, args, callId: tc.id });

          let result = "";
          let isError = false;

          try {
            switch (tc.name) {
              case "list_files": {
                const rows = await db.select().from(projectFilesTable)
                  .where(eq(projectFilesTable.projectId, projectId));
                result = rows.length === 0
                  ? "No files"
                  : rows.map((f) => `${f.path} (${f.language})`).join("\n");
                break;
              }

              case "read_file": {
                const path = String(args.path ?? "");
                const [row] = await db.select().from(projectFilesTable)
                  .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, path)))
                  .limit(1);
                if (!row) { result = `Not found: ${path}`; isError = true; }
                else result = row.content;
                break;
              }

              case "write_file": {
                const path = String(args.path ?? "");
                const content = String(args.content ?? "");
                const [existing] = await db.select().from(projectFilesTable)
                  .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, path)))
                  .limit(1);
                if (!existing) {
                  result = `Not found: ${path}. Use create_file for new files.`;
                  isError = true;
                } else {
                  await db.update(projectFilesTable)
                    .set({ content, updatedAt: new Date() })
                    .where(eq(projectFilesTable.id, existing.id));
                  result = `Updated ${path} (${content.length} chars)`;
                }
                break;
              }

              case "create_file": {
                const path = String(args.path ?? "");
                const content = String(args.content ?? "");
                const language = String(args.language ?? "plaintext");
                const [existing] = await db.select().from(projectFilesTable)
                  .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, path)))
                  .limit(1);
                if (existing) {
                  await db.update(projectFilesTable)
                    .set({ content, updatedAt: new Date() })
                    .where(eq(projectFilesTable.id, existing.id));
                  result = `Updated ${path} (already existed)`;
                } else {
                  await db.insert(projectFilesTable)
                    .values({ projectId, path, content, language, createdAt: new Date(), updatedAt: new Date() });
                  result = `Created ${path}`;
                }
                break;
              }

              case "delete_file": {
                const path = String(args.path ?? "");
                const [existing] = await db.select().from(projectFilesTable)
                  .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, path)))
                  .limit(1);
                if (!existing) { result = `Not found: ${path}`; isError = true; }
                else {
                  await db.delete(projectFilesTable).where(eq(projectFilesTable.id, existing.id));
                  result = `Deleted ${path}`;
                }
                break;
              }

              case "run_code": {
                const path = String(args.path ?? "");
                const [row] = await db.select().from(projectFilesTable)
                  .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, path)))
                  .limit(1);
                if (!row) { result = `Not found: ${path}`; isError = true; }
                else {
                  const { stdout, stderr, exitCode } = await runFile(row.language, row.content, row.path);
                  const parts = [
                    stdout && `stdout:\n${stdout.trimEnd()}`,
                    stderr && `stderr:\n${stderr.trimEnd()}`,
                    `exit: ${exitCode}`,
                  ].filter(Boolean);
                  result = parts.join("\n");
                  if (exitCode !== 0) isError = true;
                }
                break;
              }

              default:
                result = `Unknown tool: ${tc.name}`;
                isError = true;
            }
          } catch (err: unknown) {
            result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
            isError = true;
          }

          // Cap result size
          if (result.length > 8000) result = result.slice(0, 8000) + "\n...[truncated]";

          sse("tool_result", { callId: tc.id, tool: tc.name, result, isError });
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
      }

      sse("message", { text: "Done! Refresh the file list to see the changes." });
      sse("done");
      res.end();
    } catch (err: unknown) {
      req.log.error({ err }, "Agent error");
      sse("error", { message: err instanceof Error ? err.message : "Unknown agent error" });
      sse("done");
      res.end();
    }
  }
);

export default router;
