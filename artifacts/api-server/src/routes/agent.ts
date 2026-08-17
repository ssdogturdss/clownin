import { Router, type IRouter } from "express";
import { spawn } from "child_process";
import { runRemoteProcess } from "../lib/sshExecution";
import { join } from "path";
import { randomBytes, createHash } from "crypto";
import AdmZip from "adm-zip";
import { db, projectsTable, projectFilesTable, usersTable, serversTable, projectEnvVarsTable, conversationMessagesTable, conversationSessionsTable } from "@workspace/db";
import { eq, and, or, ne, lt, isNull, isNotNull, sql, asc, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import { requireAuth, getUser } from "../lib/auth";
import { syncProjectFiles, projectDir } from "../lib/projectWorkspace";
import { prepareNetlifyFiles, prepareVercelFiles } from "../lib/deployConfig";
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
            enum: ["javascript", "typescript", "python", "bash", "go", "rust", "ruby", "java", "plaintext"],
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
  {
    type: "function",
    function: {
      name: "enable_preview",
      description:
        "Generate or retrieve the shareable live-preview link for this project. The link is public and works instantly — no deployment needed. Use this whenever the user asks to preview, share, or show their project. Returns the full URL.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "deploy",
      description:
        "Deploy the project to a live hosting platform (Netlify or Vercel). Use this when the user wants a permanent public URL — not just a preview. Requires a platform API token. If the user hasn't provided a token, ask for it before calling this tool.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["netlify", "vercel"],
            description: "Hosting platform to deploy to",
          },
          token: {
            type: "string",
            description: "Platform API token (Netlify personal access token or Vercel access token)",
          },
          site_name: {
            type: "string",
            description: "Optional site/project name slug. Defaults to the project name.",
          },
        },
        required: ["platform", "token"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search all project files for a text pattern and return matching lines with file paths and line numbers. Use this BEFORE reading individual files to quickly locate where a function, variable, or string is defined or used. Much faster than reading every file.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Exact text or substring to search for",
          },
          case_insensitive: {
            type: "boolean",
            description: "If true, search case-insensitively. Defaults to false.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Make a targeted, surgical edit to a file by replacing an exact string with new content. Safer than write_file for existing files — only the changed region is touched. The old_str must match exactly as it appears in the file (including whitespace and indentation). Use enough context in old_str to make it unique. If the match is ambiguous (appears multiple times), use a longer old_str.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          old_str: {
            type: "string",
            description: "The exact string to find and replace. Must match the file contents verbatim.",
          },
          new_str: {
            type: "string",
            description: "The replacement string. May be empty to delete old_str.",
          },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_file",
      description:
        "Rename or move a file within the project without changing its content. More efficient than delete + create. Use when refactoring or reorganising the project structure.",
      parameters: {
        type: "object",
        properties: {
          old_path: { type: "string", description: "Current file path" },
          new_path: { type: "string", description: "New file path" },
          language: {
            type: "string",
            enum: ["javascript", "typescript", "python", "bash", "go", "rust", "ruby", "java", "plaintext"],
            description: "Override language if the extension changes",
          },
        },
        required: ["old_path", "new_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_terminal",
      description:
        "Run an arbitrary shell command in the project directory. Use for: creating directories (mkdir -p), git operations, curl requests, environment inspection, file system tasks, and anything that isn't just executing a code file. Output is capped at 4000 characters. Timeout is 30 seconds.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to run, e.g. 'mkdir -p src/components' or 'ls -la'",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch the content of a public URL. HTML pages are returned as readable plain text (tags stripped). JSON responses are pretty-printed. Use to look up documentation, read a package README, check an API endpoint, or verify external resources. Response is capped at 8000 characters. Timeout is 10 seconds.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
          method: {
            type: "string",
            enum: ["GET", "POST"],
            description: "HTTP method. Defaults to GET.",
          },
          body: {
            type: "string",
            description: "Request body for POST requests (JSON string)",
          },
        },
        required: ["url"],
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
    case "go":
      return { cmd: "go", args: ["run", filePath] };
    case "ruby":
    case "rb":
      return { cmd: "ruby", args: [filePath] };
    case "rust":
    case "rs": {
      const outPath = `${filePath}.bin`;
      return { cmd: "bash", args: ["-c", `rustc "${filePath}" -o "${outPath}" && "${outPath}"`] };
    }
    case "java": {
      const dir = filePath.replace(/\/[^/]+$/, "");
      const className = filePath.replace(/.*\/([^/]+)\.java$/, "$1");
      return { cmd: "bash", args: ["-c", `javac "${filePath}" && java -cp "${dir}" "${className}"`] };
    }
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
    // Do NOT inject project env vars here — the model controls what run_code
    // executes, so giving it access to decrypted secrets would allow exfiltration
    // through stdout/tool-result messages sent to OpenAI. Env var injection is
    // reserved for user-initiated /execute and /serve endpoints only.
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
// Plain-language narration emitted just before each tool call so the client
// can update its "thinking" bubble with human-readable status text.
function toolStatusNarration(name: string, args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  switch (name) {
    case "list_files":
      return "Checking what files are in your project…";
    case "read_file":
      return path ? `Reading ${path}…` : "Reading a file…";
    case "write_file":
      return path ? `Writing ${path}…` : "Updating a file…";
    case "create_file":
      return path ? `Creating ${path}…` : "Creating a new file…";
    case "delete_file":
      return path ? `Removing ${path}…` : "Deleting a file…";
    case "run_code":
      return path ? `Running ${path}…` : "Running your code…";
    case "install_packages": {
      const pkgs = Array.isArray(args.packages)
        ? (args.packages as string[]).join(", ")
        : "packages";
      return `Installing ${pkgs}…`;
    }
    case "enable_preview":
      return "Setting up a preview link…";
    case "deploy": {
      const platform = typeof args.platform === "string" ? args.platform : "your app";
      return `Deploying to ${platform}…`;
    }
    case "search_files": {
      const pat = typeof args.pattern === "string" ? args.pattern : "";
      return pat ? `Searching for "${pat}"…` : "Searching the project…";
    }
    case "edit_file": {
      const p = typeof args.path === "string" ? args.path : "";
      return p ? `Editing ${p}…` : "Editing a file…";
    }
    case "rename_file": {
      const op = typeof args.old_path === "string" ? args.old_path : "";
      return op ? `Renaming ${op}…` : "Renaming a file…";
    }
    case "run_terminal": {
      const cmd = typeof args.command === "string" ? args.command.slice(0, 40) : "command";
      return `Running: ${cmd}…`;
    }
    case "fetch_url": {
      const u = typeof args.url === "string" ? args.url : "";
      try { return `Fetching ${new URL(u).hostname}…`; }
      catch { return "Fetching a URL…"; }
    }
    default:
      return "Working on it…";
  }
}

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
      | { kind: "text"; name: string; content: string }
      | { kind: "zip"; name: string; base64: string };

    const { message, history, attachments, sessionId: clientSessionId } = req.body ?? {};
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

    // Load env var key names only — injected into the system prompt so the agent
    // knows which secrets are configured in this project.
    // SECURITY: values are NEVER decrypted here. The agent controls run_code and
    // could write code to print process.env, leaking secrets back to the model
    // through tool output. Env var values are only decrypted for user-initiated
    // runs (the /execute and /serve endpoints), never for agent-controlled runs.
    const envVarRows = await db
      .select({ key: projectEnvVarsTable.key })
      .from(projectEnvVarsTable)
      .where(eq(projectEnvVarsTable.projectId, projectId));
    const envVarKeys = envVarRows.map((r) => r.key);

    // SSE setup
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    type EvtType = "thinking" | "status" | "tool_call" | "tool_result" | "token" | "message" | "done" | "error";
    function sse(type: EvtType, payload?: unknown) {
      res.write(`data: ${JSON.stringify({ type, payload })}\n\n`);
    }

    const systemPrompt = `You are an expert autonomous coding agent inside Clownin — a mobile code editor. You write production-quality code, use tools efficiently, and always verify your work.

Project: "${project.name}" | Language: ${project.language}

━━━ TOOLS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
list_files        List all project files (always start here)
search_files      Grep across all files — use BEFORE reading to locate code fast
read_file         Read one file's full content
edit_file         Surgical find-and-replace — prefer over write_file for existing files
write_file        Overwrite an existing file entirely
create_file       Create a new file
delete_file       Delete a file
rename_file       Rename or move a file without touching its content
run_code          Execute a file — always do this after writing code; fix errors and retry
run_terminal      Arbitrary shell command: mkdir, curl, git, ls, env inspection
install_packages  npm or pip install; create package.json first if it doesn't exist
fetch_url         Fetch docs, a README, or an API endpoint (HTML stripped to text)
enable_preview    Give the user a live shareable link (no deploy needed)
deploy            Publish to Netlify or Vercel (permanent URL; ask for token first)

━━━ REASONING WORKFLOW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before writing any code:
1. list_files — see what already exists
2. search_files — find where relevant functions/vars are defined (saves reading many files)
3. read_file — read only the files that are actually relevant
4. Execute the change using the most targeted tool available

When modifying existing files:
• Use edit_file for targeted changes (a function, a block, a few lines)
• Use write_file only for wholesale rewrites
• Always run_code after writing to verify — fix errors and re-run until exit 0

When something errors:
• Read the error carefully — it almost always says exactly what's wrong
• Fix the root cause; don't mask it with try/catch
• If a module is missing, install it; if a file isn't found, create it

━━━ LANGUAGE NOTES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Go     → go run file.go  (single-file programs, standard library freely available)
Rust   → rustc file.rs   (single file, no Cargo.toml)
Ruby   → ruby file.rb    (built-in stdlib, no gem needed for standard operations)
Java   → javac + java    (filename must match public class name, e.g. Main.java)
Python → python3         (use pip3 install for packages; --user flag if needed)
JS/TS  → node / bun      (create package.json before running npm install)

━━━ TOOL SELECTION QUICK GUIDE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"where is function X?"   → search_files
"change just one block"  → edit_file (not write_file)
"create directories"     → run_terminal (mkdir -p)
"look up how X works"    → fetch_url the docs/README
"show/share the project" → enable_preview
"publish permanently"    → deploy

━━━ RESPONSES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Keep final replies concise: what you built/changed + how to use it.
Don't re-explain tool output. If you fixed an error, just say what you fixed.
Write complete code — no TODOs, no placeholders, no "add your logic here".

━━━ CURRENT PROJECT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Files:
${files.length === 0 ? "  (empty project)" : files.map((f) => `  ${f.path} (${f.language})`).join("\n")}${envVarKeys.length > 0 ? `\n\nEnvironment variables (available via process.env / os.environ in user-initiated runs):\n${envVarKeys.map((k) => `  ${k}`).join("\n")}` : ""}`;

    // ── Session resolution ────────────────────────────────────────────────────
    // If the client sends a sessionId, use it. Otherwise find the latest
    // session for this project (so the agent continues the active thread).
    // If no sessions exist at all, generate a fresh UUID.
    let activeSessionId: string;
    if (clientSessionId && typeof clientSessionId === "string") {
      activeSessionId = clientSessionId;
    } else {
      const [latestRow] = await db
        .select({ sessionId: conversationMessagesTable.sessionId })
        .from(conversationMessagesTable)
        .where(
          and(
            eq(conversationMessagesTable.projectId, projectId),
            isNotNull(conversationMessagesTable.sessionId),
          )
        )
        .orderBy(desc(conversationMessagesTable.createdAt))
        .limit(1);
      activeSessionId = latestRow?.sessionId ?? randomUUID();
    }

    // Load history from DB — server is the authoritative source so the
    // conversation survives app restarts and multi-device sessions.
    const dbMessages = await db
      .select()
      .from(conversationMessagesTable)
      .where(
        and(
          eq(conversationMessagesTable.projectId, projectId),
          eq(conversationMessagesTable.sessionId, activeSessionId),
        )
      )
      .orderBy(asc(conversationMessagesTable.createdAt))
      .limit(40);

    const conversationHistory: OpenAI.ChatCompletionMessageParam[] = dbMessages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // Persist the user's message immediately (survives connection drops)
    await db.insert(conversationMessagesTable).values({
      projectId,
      sessionId: activeSessionId,
      role: "user",
      content: message || "(attachment)",
    });

    // Auto-name the session on its first message (only if no name exists yet).
    // Uses a simple heuristic: first 6 words of the user's message, title-cased.
    if (dbMessages.length === 0 && message && typeof message === "string") {
      const autoName = message
        .trim()
        .split(/\s+/)
        .slice(0, 6)
        .join(" ")
        .replace(/[.!?]+$/, "");
      await db
        .insert(conversationSessionsTable)
        .values({ sessionId: activeSessionId, projectId, name: autoName })
        .onConflictDoNothing();
    }

    // Build user content — plain string unless images are attached
    const textFiles = inboundAttachments.filter((a) => a.kind === "text") as { kind: "text"; name: string; content: string }[];
    const images    = inboundAttachments.filter((a) => a.kind === "image") as { kind: "image"; name: string; base64: string; mimeType: string }[];
    const zipFiles  = inboundAttachments.filter((a) => a.kind === "zip")  as { kind: "zip"; name: string; base64: string }[];

    // Extract text/code files from any zip attachments and fold them into textFiles.
    // Safety limits prevent a malicious or oversized archive from exhausting memory
    // or producing a prompt too large for the model.
    const TEXT_EXTENSIONS = new Set(["js","ts","jsx","tsx","py","rb","go","rs","java","sh","bash","txt","md","json","yaml","yml","toml","html","css","scss","sql","env","gitignore","dockerfile","makefile","ini","cfg","conf"]);
    const ZIP_MAX_ENTRIES        = 50;          // max files extracted per archive
    const ZIP_MAX_ENTRY_BYTES    = 256 * 1024;  // 256 KB per file
    const ZIP_MAX_TOTAL_BYTES    = 1024 * 1024; // 1 MB total across all zip files
    let zipTotalBytes = 0;
    for (const zipAtt of zipFiles) {
      try {
        const buf = Buffer.from(zipAtt.base64, "base64");
        const zip = new AdmZip(buf);
        let entryCount = 0;
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue;
          if (entryCount >= ZIP_MAX_ENTRIES) {
            req.log.warn({ name: zipAtt.name }, "ZIP entry limit reached; skipping remaining entries");
            break;
          }
          if (zipTotalBytes >= ZIP_MAX_TOTAL_BYTES) {
            req.log.warn({ name: zipAtt.name }, "ZIP total size limit reached; skipping remaining entries");
            break;
          }
          const entryName = entry.entryName;
          // Skip hidden, binary, and build artifact paths
          if (entryName.includes("/.") || entryName.startsWith(".")) continue;
          if (entryName.includes("/node_modules/") || entryName.includes("/__pycache__/")) continue;
          const ext = entryName.split(".").pop()?.toLowerCase() ?? "";
          if (!TEXT_EXTENSIONS.has(ext)) continue;
          // Check compressed size before decompressing to avoid zip-bomb expansion
          if (entry.header.size > ZIP_MAX_ENTRY_BYTES) continue;
          try {
            const data = entry.getData();
            if (data.length > ZIP_MAX_ENTRY_BYTES) continue;
            const content = data.toString("utf8");
            zipTotalBytes += content.length;
            if (zipTotalBytes > ZIP_MAX_TOTAL_BYTES) {
              req.log.warn({ name: zipAtt.name, entryName }, "ZIP total size limit reached mid-entry; skipping");
              zipTotalBytes -= content.length; // roll back the overage
              break;
            }
            textFiles.push({ kind: "text", name: `${zipAtt.name}/${entryName}`, content });
            entryCount++;
          } catch { /* skip unreadable entries */ }
        }
      } catch (zipErr) {
        req.log.warn({ zipErr, name: zipAtt.name }, "Failed to extract zip attachment");
      }
    }

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
    let finalAgentText = ""; // tracked so we can persist it after the loop
    req.on("close", () => { aborted = true; });

    try {
      while (iteration < MAX_ITERATIONS && !aborted) {
        iteration++;
        if (iteration > 1) {
          sse("status", { text: "Reviewing the results, planning what to do next…" });
        }

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
          if (textContent) {
            finalAgentText = textContent;
            sse("message", { text: textContent });
          }
          sse("done", { sessionId: activeSessionId });
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

          sse("status", { text: toolStatusNarration(tc.name, args) });
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
                  const allFiles = await db.select().from(projectFilesTable)
                    .where(eq(projectFilesTable.projectId, projectId));

                  // ── SSH path ────────────────────────────────────────────────
                  if (project.serverId) {
                    const [server] = await db.select().from(serversTable)
                      .where(and(eq(serversTable.id, project.serverId), eq(serversTable.userId, userId)))
                      .limit(1);
                    if (!server) {
                      result = "Custom server not found — detach it from this project and try again.";
                      isError = true;
                    } else {
                      // No project env vars injected here — model controls run_code
                      // and could exfiltrate secrets through tool output.
                      const { stdout, stderr, exitCode } = await runRemoteProcess(
                        { host: server.host, port: server.port, username: server.username, password: server.password, privateKey: server.privateKey },
                        projectId, allFiles, row.path, row.language, EXEC_TIMEOUT_MS
                      );
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

                  // ── Local path ──────────────────────────────────────────────
                  const dir = await syncProjectFiles(projectId, allFiles);
                  const { join: pathJoin } = await import("path");
                  const absPath = pathJoin(dir, row.path);
                  const executor = execCommand(row.language, absPath);
                  if (!executor) {
                    result = `Cannot run ${row.path} — only JavaScript, TypeScript, Python, and Bash files can be executed. If you meant to run a different file, specify its path.`; isError = true;
                  } else {
                    // No project env vars injected — see comment above on SSH path.
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

              case "enable_preview": {
                // Fetch project and reuse or generate a short ID
                const [proj] = await db.select().from(projectsTable)
                  .where(eq(projectsTable.id, projectId)).limit(1);

                let shortId = (proj?.previewEnabled && proj?.previewShortId) ? proj.previewShortId : null;
                if (!shortId) {
                  // Generate a unique 10-hex short ID (same algorithm as preview/enable route)
                  for (let attempt = 0; attempt < 5; attempt++) {
                    const candidate = randomBytes(5).toString("hex");
                    const [conflict] = await db.select({ id: projectsTable.id })
                      .from(projectsTable)
                      .where(eq(projectsTable.previewShortId, candidate))
                      .limit(1);
                    if (!conflict) { shortId = candidate; break; }
                  }
                  if (!shortId) { result = "Could not generate preview ID — try again."; isError = true; break; }
                }

                await db.update(projectsTable)
                  .set({ previewShortId: shortId, previewEnabled: true })
                  .where(eq(projectsTable.id, projectId));

                const baseUrl = `${req.protocol}://${req.get("host")}`;
                result = `Preview ready! Share this link:\n${baseUrl}/preview/${shortId}`;
                break;
              }

              case "deploy": {
                const platform  = String(args.platform ?? "netlify");
                const token     = String(args.token ?? "");
                const siteName  = args.site_name ? String(args.site_name) : undefined;

                if (!token) {
                  result = "token is required. Please provide your Netlify or Vercel API token.";
                  isError = true;
                  break;
                }

                const allFiles = await db.select().from(projectFilesTable)
                  .where(eq(projectFilesTable.projectId, projectId));
                if (!allFiles.length) {
                  result = "No files to deploy — create some files first.";
                  isError = true;
                  break;
                }

                const [proj] = await db.select().from(projectsTable)
                  .where(eq(projectsTable.id, projectId)).limit(1);

                const cleanName = (siteName || proj?.name || "clownin-app")
                  .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-")
                  .replace(/^-|-$/g, "").slice(0, 63);

                const rawFiles = allFiles.map((f) => ({ path: f.path, content: f.content }));

                if (platform === "netlify") {
                  const { files: deployFiles, type, warning } = prepareNetlifyFiles(rawFiles);

                  // 1. Create site
                  const siteRes = await fetch(`https://api.netlify.com/api/v1/sites`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "Clownin-App/1.0" },
                    body: JSON.stringify({ name: cleanName }),
                  });
                  if (!siteRes.ok) {
                    const err = ((await siteRes.json().catch(() => ({}))) as { message?: string }).message || `Netlify error ${siteRes.status}`;
                    result = `Netlify error: ${err}`; isError = true; break;
                  }
                  const site = await siteRes.json() as { id: string; ssl_url?: string; url?: string };

                  // 2. Build digest map
                  const fileMap: Record<string, string> = {};
                  const contentMap: Record<string, Buffer> = {};
                  for (const f of deployFiles) {
                    const buf = Buffer.from(f.content, "utf8");
                    const sha1 = createHash("sha1").update(buf).digest("hex");
                    const key = f.path.startsWith("/") ? f.path : `/${f.path}`;
                    fileMap[key] = sha1;
                    contentMap[key] = buf;
                  }

                  // 3. Create deploy
                  const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/deploys`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "Clownin-App/1.0" },
                    body: JSON.stringify({ files: fileMap }),
                  });
                  if (!deployRes.ok) {
                    const err = ((await deployRes.json().catch(() => ({}))) as { message?: string }).message || `Netlify deploy error ${deployRes.status}`;
                    result = `Netlify error: ${err}`; isError = true; break;
                  }
                  const deploy = await deployRes.json() as { id: string; required: string[] };

                  // 4. Upload required files
                  const required = new Set(deploy.required ?? []);
                  for (const [path, buf] of Object.entries(contentMap)) {
                    const sha1 = fileMap[path];
                    if (!required.has(sha1)) continue;
                    const encoded = path.split("/").map(encodeURIComponent).join("/");
                    await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}/files${encoded}`, {
                      method: "PUT",
                      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "Content-Length": String(buf.length), "User-Agent": "Clownin-App/1.0" },
                      body: buf,
                    });
                  }

                  const liveUrl = site.ssl_url || site.url;
                  if (!liveUrl) throw new Error("Netlify did not return a site URL. Check your token and try again.");
                  result = `Deployed to Netlify! 🚀\nLive URL: ${liveUrl}\nType: ${type}${warning ? `\nNote: ${warning}` : ""}`;

                } else if (platform === "vercel") {
                  const { files: deployFiles, type, warning } = prepareVercelFiles(rawFiles);

                  // 1. Upload files
                  const fileRefs: Array<{ file: string; sha: string; size: number }> = [];
                  for (const f of deployFiles) {
                    const buf = Buffer.from(f.content, "utf8");
                    const sha1 = createHash("sha1").update(buf).digest("hex");
                    await fetch(`https://api.vercel.com/v2/files`, {
                      method: "POST",
                      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "Content-Length": String(buf.length), "x-vercel-digest": sha1, "User-Agent": "Clownin-App/1.0" },
                      body: buf,
                    });
                    fileRefs.push({ file: f.path, sha: sha1, size: buf.length });
                  }

                  // 2. Create deployment
                  const deplRes = await fetch(`https://api.vercel.com/v13/deployments`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "Clownin-App/1.0" },
                    body: JSON.stringify({ name: cleanName, files: fileRefs, projectSettings: { framework: null }, target: "production" }),
                  });
                  const depl = await deplRes.json() as { url?: string; id?: string; error?: { message?: string } };
                  if (!deplRes.ok) {
                    result = `Vercel error: ${depl.error?.message || deplRes.status}`; isError = true; break;
                  }

                  if (!depl.url) throw new Error("Vercel did not return a deployment URL. Check your token and try again.");
                  const liveUrl = `https://${depl.url}`;
                  result = `Deployed to Vercel! 🚀\nLive URL: ${liveUrl}\nType: ${type}${warning ? `\nNote: ${warning}` : ""}`;

                } else {
                  result = `Unknown platform: ${platform}. Supported: netlify, vercel.`;
                  isError = true;
                }
                break;
              }

              case "search_files": {
                const pattern = String(args.pattern ?? "");
                const caseInsensitive = Boolean(args.case_insensitive);
                if (!pattern) { result = "pattern is required"; isError = true; break; }

                const allFiles = await db.select().from(projectFilesTable)
                  .where(eq(projectFilesTable.projectId, projectId));

                const matches: string[] = [];
                for (const file of allFiles) {
                  const lines = file.content.split("\n");
                  for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const haystack = caseInsensitive ? line.toLowerCase() : line;
                    const needle   = caseInsensitive ? pattern.toLowerCase() : pattern;
                    if (haystack.includes(needle)) {
                      matches.push(`${file.path}:${i + 1}: ${line.trimEnd()}`);
                    }
                  }
                }

                if (matches.length === 0) {
                  result = `No matches for "${pattern}"`;
                } else {
                  const cap = 200;
                  result = matches.slice(0, cap).join("\n");
                  if (matches.length > cap) result += `\n… (${matches.length - cap} more matches not shown)`;
                }
                break;
              }

              case "edit_file": {
                const path    = String(args.path ?? "");
                const oldStr  = String(args.old_str ?? "");
                const newStr  = String(args.new_str ?? "");
                if (!path || oldStr === "") { result = "path and old_str are required"; isError = true; break; }

                const [row] = await db.select().from(projectFilesTable)
                  .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, path)))
                  .limit(1);
                if (!row) { result = `Not found: ${path}`; isError = true; break; }

                if (!row.content.includes(oldStr)) {
                  result = `old_str not found in ${path}. Check that the whitespace and indentation match exactly.`;
                  isError = true;
                  break;
                }

                const occurrences = row.content.split(oldStr).length - 1;
                if (occurrences > 1) {
                  result = `old_str appears ${occurrences} times in ${path} — use a longer, more unique old_str.`;
                  isError = true;
                  break;
                }

                const newContent = row.content.replace(oldStr, newStr);
                await db.update(projectFilesTable)
                  .set({ content: newContent, updatedAt: new Date() })
                  .where(eq(projectFilesTable.id, row.id));
                result = `Edited ${path}`;
                break;
              }

              case "rename_file": {
                const oldPath = String(args.old_path ?? "");
                const newPath = String(args.new_path ?? "");
                if (!oldPath || !newPath) { result = "old_path and new_path are required"; isError = true; break; }

                const [row] = await db.select().from(projectFilesTable)
                  .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, oldPath)))
                  .limit(1);
                if (!row) { result = `Not found: ${oldPath}`; isError = true; break; }

                const [conflict] = await db.select({ id: projectFilesTable.id }).from(projectFilesTable)
                  .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, newPath)))
                  .limit(1);
                if (conflict) { result = `${newPath} already exists — delete it first.`; isError = true; break; }

                const newLanguage = args.language ? String(args.language) : row.language;
                await db.update(projectFilesTable)
                  .set({ path: newPath, language: newLanguage, updatedAt: new Date() })
                  .where(eq(projectFilesTable.id, row.id));
                result = `Renamed ${oldPath} → ${newPath}`;
                break;
              }

              case "run_terminal": {
                const command = String(args.command ?? "").trim();
                if (!command) { result = "command is required"; isError = true; break; }

                const allFiles = await db.select().from(projectFilesTable)
                  .where(eq(projectFilesTable.projectId, projectId));
                const dir = await syncProjectFiles(projectId, allFiles);

                const TERMINAL_TIMEOUT_MS = 30_000;
                const TERMINAL_OUTPUT_CAP = 4000;

                const { stdout, stderr, exitCode } = await runProcess(
                  "sh", ["-c", command], dir, TERMINAL_TIMEOUT_MS,
                );

                const raw = [
                  stdout && `stdout:\n${stdout.trimEnd()}`,
                  stderr && `stderr:\n${stderr.trimEnd()}`,
                  `exit: ${exitCode}`,
                ].filter(Boolean).join("\n");

                result = raw.length > TERMINAL_OUTPUT_CAP
                  ? raw.slice(0, TERMINAL_OUTPUT_CAP) + "\n… (truncated)"
                  : raw;
                if (exitCode !== 0) isError = true;
                break;
              }

              case "fetch_url": {
                const url    = String(args.url ?? "").trim();
                const method = String(args.method ?? "GET").toUpperCase();
                const body   = args.body ? String(args.body) : undefined;
                if (!url) { result = "url is required"; isError = true; break; }

                const FETCH_TIMEOUT_MS   = 10_000;
                const FETCH_OUTPUT_CAP   = 8000;

                try {
                  const controller = new AbortController();
                  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

                  const res = await fetch(url, {
                    method,
                    headers: {
                      "User-Agent": "Clownin-Agent/1.0",
                      "Accept": "text/html,application/json,text/plain,*/*",
                      ...(body ? { "Content-Type": "application/json" } : {}),
                    },
                    body: body && method !== "GET" ? body : undefined,
                    signal: controller.signal,
                  });
                  clearTimeout(tid);

                  const contentType = res.headers.get("content-type") ?? "";
                  const raw = await res.text();

                  let text: string;
                  if (contentType.includes("application/json")) {
                    try { text = JSON.stringify(JSON.parse(raw), null, 2); }
                    catch { text = raw; }
                  } else {
                    text = raw
                      .replace(/<script[\s\S]*?<\/script>/gi, "")
                      .replace(/<style[\s\S]*?<\/style>/gi, "")
                      .replace(/<[^>]+>/g, " ")
                      .replace(/&nbsp;/g, " ")
                      .replace(/&amp;/g, "&")
                      .replace(/&lt;/g, "<")
                      .replace(/&gt;/g, ">")
                      .replace(/\s+/g, " ")
                      .trim();
                  }

                  result = `HTTP ${res.status}\n` +
                    (text.length > FETCH_OUTPUT_CAP
                      ? text.slice(0, FETCH_OUTPUT_CAP) + "\n… (truncated)"
                      : text);
                  if (!res.ok) isError = true;
                } catch (err: unknown) {
                  result = err instanceof Error ? err.message : "fetch failed";
                  isError = true;
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
      sse("done", { sessionId: activeSessionId });
      res.end();
    } catch (err: unknown) {
      req.log.error({ err }, "Agent error");
      sse("error", { message: err instanceof Error ? err.message : "Unknown agent error" });
      sse("done");
      res.end();
    } finally {
      // Persist the assistant's reply regardless of how the agent loop exited.
      // Runs after return statements too, so all exit paths are covered.
      if (finalAgentText) {
        await db
          .insert(conversationMessagesTable)
          .values({ projectId, sessionId: activeSessionId, role: "assistant", content: finalAgentText })
          .catch((err) => req.log.warn({ err }, "Failed to persist assistant message"));
      }
    }
  }
);

export default router;
