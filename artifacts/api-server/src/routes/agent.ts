import { Router, type IRouter } from "express";
import { spawn } from "child_process";
import { join } from "path";
import { db, projectsTable, projectFilesTable, usersTable } from "@workspace/db";
import { eq, and, or, ne, lt, isNull, sql } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { syncProjectFiles, projectDir } from "../lib/projectWorkspace";
import OpenAI from "openai";

const router: IRouter = Router();

function getOpenAI(): OpenAI {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey || !baseURL) throw new Error("Replit AI integration not configured");
  return new OpenAI({ apiKey, baseURL });
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
  {
    type: "function",
    function: {
      name: "install_packages",
      description:
        "Install packages for the project. For JavaScript/TypeScript use npm, for Python use pip. Always create package.json first if it doesn't exist before running npm install. Run this before run_code when the code requires external packages.",
      parameters: {
        type: "object",
        properties: {
          packages: {
            type: "array",
            items: { type: "string" },
            description: "Package names, e.g. ['lodash', 'axios']",
          },
          manager: {
            type: "string",
            enum: ["npm", "pip"],
            description: "npm for JS/TS, pip for Python",
          },
        },
        required: ["packages", "manager"],
      },
    },
  },
];

// ── Execution helpers ─────────────────────────────────────────────────────────
const EXEC_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 60_000;

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

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const safeEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
    };

    const child = spawn(cmd, args, { timeout: timeoutMs, env: safeEnv, cwd });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n[Timed out after ${timeoutMs / 1000}s]`;
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
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

    type InboundAttachment =
      | { kind: "image"; name: string; base64: string; mimeType: string }
      | { kind: "text"; name: string; content: string };

    const { message, history, attachments } = req.body ?? {};
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const inboundAttachments: InboundAttachment[] = Array.isArray(attachments) ? attachments : [];

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

    // ── Subscription enforcement (atomic) ────────────────────────────────────
    const [currentUser] = await db
      .select({ subscriptionTier: usersTable.subscriptionTier })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (currentUser?.subscriptionTier === "free") {
      const todayStr = new Date().toISOString().slice(0, 10);

      // Single atomic UPDATE: increment only if under the daily limit.
      // The CASE resets the count to 1 on a new day; the WHERE prevents
      // the update when the same-day count is already at the ceiling.
      // This eliminates the read-modify-write race under concurrent requests.
      const updated = await db
        .update(usersTable)
        .set({
          dailyMessageCount: sql`CASE WHEN ${usersTable.lastMessageDate} = ${todayStr} THEN ${usersTable.dailyMessageCount} + 1 ELSE 1 END`,
          lastMessageDate: todayStr,
        })
        .where(
          and(
            eq(usersTable.id, userId),
            eq(usersTable.subscriptionTier, "free"),
            or(
              isNull(usersTable.lastMessageDate),       // first-ever message
              ne(usersTable.lastMessageDate, todayStr), // new day → reset to 1
              lt(usersTable.dailyMessageCount, 20)      // same day, still under limit
            )
          )
        )
        .returning({ dailyMessageCount: usersTable.dailyMessageCount });

      if (updated.length === 0) {
        // WHERE matched no rows → limit already reached for today
        res.status(402).json({
          error: "Daily message limit reached",
          code: "daily_limit_exceeded",
          limit: 20,
          tier: "free",
        });
        return;
      }
    }
    // ── End subscription enforcement ─────────────────────────────────────────

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

    // Build user content — plain string unless images are attached
    const textFiles = inboundAttachments.filter((a) => a.kind === "text") as { kind: "text"; name: string; content: string }[];
    const images    = inboundAttachments.filter((a) => a.kind === "image") as { kind: "image"; name: string; base64: string; mimeType: string }[];

    let userText = message;
    if (textFiles.length > 0) {
      const ctx = textFiles.map((f) => `--- ${f.name} ---\n${f.content}`).join("\n\n");
      userText = `${ctx}\n\n${message}`;
    }

    const userContent: OpenAI.ChatCompletionUserMessageParam["content"] =
      images.length === 0
        ? userText
        : [
            { type: "text", text: userText },
            ...images.map((img) => ({
              type: "image_url" as const,
              image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
            })),
          ];

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
      { role: "user", content: userContent },
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

        // Retry up to 3 times on 429 rate-limit with exponential backoff
        let stream: Awaited<ReturnType<typeof openai.chat.completions.create>>;
        {
          let attempt = 0;
          const delays = [1000, 2000, 4000];
          while (true) {
            try {
              stream = await openai.chat.completions.create({
                model: "gpt-5.6-terra",
                messages,
                tools: AGENT_TOOLS,
                tool_choice: "auto",
                stream: true,
                max_completion_tokens: 8192,
              });
              break;
            } catch (err: unknown) {
              const status = (err as { status?: number }).status;
              if (status === 429 && attempt < delays.length) {
                req.log.warn({ attempt, delay: delays[attempt] }, "Rate limited — retrying");
                await new Promise((r) => setTimeout(r, delays[attempt]));
                attempt++;
              } else {
                throw err;
              }
            }
          }
        }

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
                  // Sync all project files so multi-file imports and node_modules work
                  const allFiles = await db.select().from(projectFilesTable)
                    .where(eq(projectFilesTable.projectId, projectId));
                  const dir = await syncProjectFiles(projectId, allFiles);
                  const { join: pathJoin } = await import("path");
                  const absPath = pathJoin(dir, row.path);
                  const executor = execCommand(row.language, absPath);
                  if (!executor) {
                    result = `Cannot run ${row.path} — only JavaScript, TypeScript, Python, and Bash files can be executed. If you meant to run a different file, specify its path.`; isError = true;
                  } else {
                    const { stdout, stderr, exitCode } = await runProcess(
                      executor.cmd, executor.args, dir, EXEC_TIMEOUT_MS
                    );
                    const parts = [
                      stdout && `stdout:\n${stdout.trimEnd()}`,
                      stderr && `stderr:\n${stderr.trimEnd()}`,
                      `exit: ${exitCode}`,
                    ].filter(Boolean);
                    result = parts.join("\n");
                    if (exitCode !== 0) isError = true;
                  }
                }
                break;
              }

              case "install_packages": {
                const pkgs = (args.packages as string[]) ?? [];
                const manager = String(args.manager ?? "npm");
                if (pkgs.length === 0) { result = "No packages specified"; isError = true; break; }

                // Sync files so cwd exists
                const allFiles = await db.select().from(projectFilesTable)
                  .where(eq(projectFilesTable.projectId, projectId));
                const dir = await syncProjectFiles(projectId, allFiles);

                if (manager === "pip") {
                  const { stdout, stderr, exitCode } = await runProcess(
                    "pip3", ["install", "--user", ...pkgs], dir, INSTALL_TIMEOUT_MS
                  );
                  result = [stdout && `stdout:\n${stdout.trimEnd()}`, stderr && `stderr:\n${stderr.trimEnd()}`, `exit: ${exitCode}`].filter(Boolean).join("\n");
                  if (exitCode !== 0) isError = true;
                } else {
                  // npm — use project dir as cwd so package.json is respected
                  const { stdout, stderr, exitCode } = await runProcess(
                    "npm", ["install", ...pkgs], dir, INSTALL_TIMEOUT_MS
                  );
                  result = [stdout && `stdout:\n${stdout.trimEnd()}`, stderr && `stderr:\n${stderr.trimEnd()}`, `exit: ${exitCode}`].filter(Boolean).join("\n");
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
