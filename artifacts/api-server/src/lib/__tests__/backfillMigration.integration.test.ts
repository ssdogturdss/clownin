/**
 * Integration tests for lib/db/migrations/0007_backfill_session_names.sql.
 *
 * These tests connect to the real PostgreSQL database, set up an isolated
 * schema with minimal versions of the two tables the migration touches, run
 * the ACTUAL migration SQL read from disk, and assert the resulting rows.
 *
 * The schema is dropped at the end of each test so runs are idempotent and
 * never touch production data.
 *
 * Tests are skipped automatically when DATABASE_URL is not set.
 *
 * Cases covered:
 *   - Sessions with user messages get a name row (first 6 words, trailing
 *     sentence punctuation stripped) — mirrors the runtime auto-naming heuristic
 *   - Sessions that already have a name in conversation_sessions are left
 *     untouched (WHERE NOT EXISTS / ON CONFLICT DO NOTHING)
 *   - Sessions with only assistant messages get no name row
 *   - Sessions whose first user message is all ASCII spaces get no name row
 *   - The earliest user message (by created_at) drives the name
 *   - Consecutive spaces in content produce empty tokens that survive
 *     array_to_string, preserving the double space in the name
 *   - Tab/newline-only content is NOT treated as blank by PostgreSQL's
 *     trim() (which only strips ASCII space 0x20)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

const { Client } = pg;

// ── Skip when no DB is available ──────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const hasDb = !!DATABASE_URL;

// ── Load the real migration SQL from disk ─────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
// Resolve relative to the test file: __tests__/ → lib/ → src/ → api-server/ → artifacts/ → root/
const MIGRATION_SQL = readFileSync(
  resolve(__dir, "../../../../../lib/db/migrations/0007_backfill_session_names.sql"),
  "utf-8",
);

// ── Per-test isolated schema ──────────────────────────────────────────────────

let client: InstanceType<typeof Client>;
let schema: string;

beforeEach(async () => {
  if (!hasDb) return;

  // Unique schema name per test to allow parallel runs without collisions.
  schema = `test_backfill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  // Isolated schema with just the two tables the migration reads/writes.
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);

  await client.query(`
    CREATE TABLE conversation_messages (
      id          SERIAL PRIMARY KEY,
      session_id  TEXT,
      project_id  INTEGER NOT NULL DEFAULT 1,
      role        TEXT    NOT NULL,
      content     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE conversation_sessions (
      session_id  TEXT        PRIMARY KEY,
      project_id  INTEGER     NOT NULL,
      name        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
});

afterEach(async () => {
  if (!hasDb || !client) return;
  try {
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
});

// ── Helper: insert a message row ──────────────────────────────────────────────

async function insertMsg(opts: {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  projectId?: number;
  createdAt?: string;
}) {
  await client.query(
    `INSERT INTO conversation_messages (session_id, project_id, role, content, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      opts.sessionId,
      opts.projectId ?? 1,
      opts.role,
      opts.content,
      opts.createdAt ?? "2024-01-01T00:00:00Z",
    ],
  );
}

// ── Helper: run the actual migration SQL ──────────────────────────────────────

async function runMigration() {
  await client.query(MIGRATION_SQL);
}

// ── Helper: fetch all rows from conversation_sessions ────────────────────────

async function fetchSessions(): Promise<
  Array<{ session_id: string; project_id: number; name: string | null }>
> {
  const res = await client.query(
    `SELECT session_id, project_id, name FROM conversation_sessions ORDER BY session_id`,
  );
  return res.rows;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("0007_backfill_session_names.sql migration", () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it.skipIf(!hasDb)(
    "inserts a name row for a session that has a user message and no existing entry",
    async () => {
      await insertMsg({ sessionId: "s1", role: "user", content: "Hello world" });
      await runMigration();

      const rows = await fetchSessions();
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe("s1");
      expect(rows[0].name).toBe("Hello world");
    },
  );

  it.skipIf(!hasDb)(
    "truncates the name to the first 6 space-delimited tokens",
    async () => {
      await insertMsg({
        sessionId: "s1",
        role: "user",
        content: "one two three four five six seven eight",
      });
      await runMigration();

      const [row] = await fetchSessions();
      expect(row.name).toBe("one two three four five six");
    },
  );

  it.skipIf(!hasDb)(
    "keeps the full name when the message has 6 or fewer words",
    async () => {
      await insertMsg({ sessionId: "s1", role: "user", content: "Fix the login bug" });
      await runMigration();

      const [row] = await fetchSessions();
      expect(row.name).toBe("Fix the login bug");
    },
  );

  // ── Punctuation stripping ───────────────────────────────────────────────────

  it.skipIf(!hasDb)("strips a trailing period", async () => {
    await insertMsg({ sessionId: "s1", role: "user", content: "Hello world." });
    await runMigration();
    const [row] = await fetchSessions();
    expect(row.name).toBe("Hello world");
  });

  it.skipIf(!hasDb)("strips a trailing exclamation mark", async () => {
    await insertMsg({ sessionId: "s1", role: "user", content: "Fix this now!" });
    await runMigration();
    const [row] = await fetchSessions();
    expect(row.name).toBe("Fix this now");
  });

  it.skipIf(!hasDb)("strips a trailing question mark", async () => {
    await insertMsg({ sessionId: "s1", role: "user", content: "How do I do this?" });
    await runMigration();
    const [row] = await fetchSessions();
    expect(row.name).toBe("How do I do this");
  });

  it.skipIf(!hasDb)("strips multiple trailing punctuation characters", async () => {
    await insertMsg({ sessionId: "s1", role: "user", content: "Are you sure?!" });
    await runMigration();
    const [row] = await fetchSessions();
    expect(row.name).toBe("Are you sure");
  });

  it.skipIf(!hasDb)("preserves mid-sentence punctuation (commas inside tokens kept)", async () => {
    await insertMsg({
      sessionId: "s1",
      role: "user",
      // 8 words — first 6: "Fix login, signup, and profile pages"
      content: "Fix login, signup, and profile pages on mobile.",
    });
    await runMigration();
    const [row] = await fetchSessions();
    expect(row.name).toBe("Fix login, signup, and profile pages");
  });

  // ── Earliest message wins ───────────────────────────────────────────────────

  it.skipIf(!hasDb)(
    "uses the earliest user message when a session has multiple",
    async () => {
      await insertMsg({
        sessionId: "s1",
        role: "user",
        content: "Second message",
        createdAt: "2024-01-01T01:00:00Z",
      });
      await insertMsg({
        sessionId: "s1",
        role: "user",
        content: "First message",
        createdAt: "2024-01-01T00:00:00Z",
      });
      await runMigration();

      const [row] = await fetchSessions();
      expect(row.name).toBe("First message");
    },
  );

  // ── Sessions that already have a name are untouched ─────────────────────────

  it.skipIf(!hasDb)(
    "does not overwrite a session that already has a name row (ON CONFLICT DO NOTHING)",
    async () => {
      await insertMsg({ sessionId: "s1", role: "user", content: "New content" });
      // Pre-existing name row — simulates a session named before the migration
      await client.query(
        `INSERT INTO conversation_sessions (session_id, project_id, name) VALUES ($1, $2, $3)`,
        ["s1", 1, "Existing name"],
      );

      await runMigration();

      const [row] = await fetchSessions();
      expect(row.name).toBe("Existing name");
    },
  );

  it.skipIf(!hasDb)(
    "names new sessions while leaving already-named ones alone",
    async () => {
      await insertMsg({ sessionId: "s1", role: "user", content: "Already named session" });
      await insertMsg({ sessionId: "s2", role: "user", content: "New session needs name" });

      await client.query(
        `INSERT INTO conversation_sessions (session_id, project_id, name) VALUES ($1, $2, $3)`,
        ["s1", 1, "Pre-existing name"],
      );

      await runMigration();

      const rows = await fetchSessions();
      expect(rows).toHaveLength(2);

      const bySession = Object.fromEntries(rows.map((r) => [r.session_id, r]));
      expect(bySession["s1"].name).toBe("Pre-existing name");
      expect(bySession["s2"].name).toBe("New session needs name");
    },
  );

  // ── Sessions with only assistant messages (edge case) ───────────────────────

  it.skipIf(!hasDb)(
    "does not insert a name row when a session has only assistant messages",
    async () => {
      await insertMsg({
        sessionId: "s1",
        role: "assistant",
        content: "Hello! How can I help you?",
      });
      await runMigration();

      const rows = await fetchSessions();
      expect(rows).toHaveLength(0);
    },
  );

  it.skipIf(!hasDb)(
    "ignores assistant messages when selecting the earliest user message",
    async () => {
      await insertMsg({
        sessionId: "s1",
        role: "assistant",
        content: "Earlier assistant reply",
        createdAt: "2024-01-01T00:00:00Z",
      });
      await insertMsg({
        sessionId: "s1",
        role: "user",
        content: "Later user message",
        createdAt: "2024-01-01T01:00:00Z",
      });
      await runMigration();

      const [row] = await fetchSessions();
      expect(row.name).toBe("Later user message");
    },
  );

  // ── Sessions whose user message is all ASCII spaces (edge case) ──────────────

  it.skipIf(!hasDb)(
    "does not insert a name row when the only user message is all ASCII spaces",
    async () => {
      await insertMsg({ sessionId: "s1", role: "user", content: "     " });
      await runMigration();

      const rows = await fetchSessions();
      expect(rows).toHaveLength(0);
    },
  );

  it.skipIf(!hasDb)(
    "skips space-only messages and uses the next valid user message",
    async () => {
      await insertMsg({
        sessionId: "s1",
        role: "user",
        content: "   ",
        createdAt: "2024-01-01T00:00:00Z",
      });
      await insertMsg({
        sessionId: "s1",
        role: "user",
        content: "Real message",
        createdAt: "2024-01-01T01:00:00Z",
      });
      await runMigration();

      const [row] = await fetchSessions();
      expect(row.name).toBe("Real message");
    },
  );

  it.skipIf(!hasDb)(
    "does not insert a name row when all user messages in a session are ASCII spaces",
    async () => {
      await insertMsg({ sessionId: "s1", role: "user", content: " " });
      await insertMsg({ sessionId: "s1", role: "user", content: "   " });
      await runMigration();

      const rows = await fetchSessions();
      expect(rows).toHaveLength(0);
    },
  );

  // ── Tab/newline content passes PostgreSQL's space-trim guard ─────────────────
  //
  // PostgreSQL's trim(content) is btrim(content, ' ') — it only strips ASCII
  // space 0x20, not \t or \n. A message that is only a tab is NOT blank after
  // trim, so the migration inserts a row for it.

  it.skipIf(!hasDb)(
    "inserts a name row for a tab-only user message (PostgreSQL trim does not strip tabs)",
    async () => {
      await insertMsg({ sessionId: "s1", role: "user", content: "\t" });
      await runMigration();

      const rows = await fetchSessions();
      // Row IS inserted because trim('\t') → '\t' (non-empty in PostgreSQL)
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe("s1");
    },
  );

  // ── Consecutive spaces in content preserve empty tokens ──────────────────────
  //
  // string_to_array('word1  word2', ' ') → {word1,'',word2}
  // array_to_string({word1,'',word2}, ' ') → 'word1  word2'
  // The double space survives into the name.

  it.skipIf(!hasDb)(
    "preserves double spaces in the name when content has consecutive spaces",
    async () => {
      await insertMsg({ sessionId: "s1", role: "user", content: "word1  word2" });
      await runMigration();

      const [row] = await fetchSessions();
      expect(row.name).toBe("word1  word2");
    },
  );

  // ── Multiple sessions processed in a single migration run ───────────────────

  it.skipIf(!hasDb)(
    "processes multiple sessions in one pass and names each correctly",
    async () => {
      await insertMsg({ sessionId: "s1", role: "user", content: "First session" });
      await insertMsg({ sessionId: "s2", role: "user", content: "Second session" });
      await insertMsg({ sessionId: "s3", role: "assistant", content: "No user message" });
      await runMigration();

      const rows = await fetchSessions();
      expect(rows).toHaveLength(2);

      const bySession = Object.fromEntries(rows.map((r) => [r.session_id, r]));
      expect(bySession["s1"].name).toBe("First session");
      expect(bySession["s2"].name).toBe("Second session");
      expect(bySession["s3"]).toBeUndefined();
    },
  );

  // ── projectId is propagated ──────────────────────────────────────────────────

  it.skipIf(!hasDb)(
    "copies the projectId from the message onto the inserted session row",
    async () => {
      await insertMsg({ sessionId: "s1", role: "user", content: "Hello", projectId: 42 });
      await runMigration();

      const [row] = await fetchSessions();
      expect(row.project_id).toBe(42);
    },
  );

  // ── Idempotency: running twice produces no duplicates ───────────────────────

  it.skipIf(!hasDb)(
    "is idempotent — running the migration twice does not create duplicate rows",
    async () => {
      await insertMsg({ sessionId: "s1", role: "user", content: "Hello world" });
      await runMigration();
      await runMigration(); // second run — ON CONFLICT DO NOTHING

      const rows = await fetchSessions();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Hello world");
    },
  );
});
