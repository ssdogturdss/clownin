/**
 * Tests for the 0007_backfill_session_names.sql migration logic.
 *
 * runBackfillLogic is a faithful JavaScript translation of the SQL so that
 * every case here maps 1-to-1 to what the real migration query does.
 *
 * Key PostgreSQL semantics preserved:
 *   - trim(content) strips only ASCII space 0x20 from both ends (btrim),
 *     NOT tab, newline, or other whitespace characters.
 *   - string_to_array(trimmed, ' ') preserves empty-string tokens when
 *     consecutive spaces appear — array_to_string then re-joins them,
 *     producing the same double-space in the resulting name.
 *   - [1:6] slice maps to JS .slice(0, 6) — no off-by-one.
 *   - regexp_replace('[.!?]+$', '') strips trailing sentence punctuation.
 *
 * Cases:
 *   - Sessions with user messages get a name (first 6 tokens, trailing punct stripped)
 *   - Sessions that already have a name in conversation_sessions are skipped (ON CONFLICT)
 *   - Sessions with only assistant messages get no name
 *   - Sessions whose only user messages contain nothing but ASCII spaces get no name
 *   - Sessions where the first user message has tab/newline-only content after
 *     space-trim DO get a row (PostgreSQL trim only removes spaces)
 *   - The earliest user message (by created_at) drives the name, not the latest
 *   - Consecutive spaces in content produce double-space tokens in the name
 *   - Names longer than 6 tokens are truncated; shorter names keep every word
 *   - Trailing . ! ? (or combinations) are stripped; internal punctuation is kept
 */

import { describe, it, expect } from "vitest";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  sessionId: string;
  projectId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

interface SessionRow {
  sessionId: string;
  projectId: number;
  name: string;
}

// ── PostgreSQL-compatible trim ────────────────────────────────────────────────

/**
 * Mirrors PostgreSQL's trim(content) / btrim(content, ' '):
 * strips only ASCII space (0x20) from both ends, NOT \t, \n, \r, etc.
 */
function pgTrim(s: string): string {
  return s.replace(/^ +| +$/g, "");
}

// ── Migration logic (mirrors 0007_backfill_session_names.sql) ─────────────────

/**
 * Pure-JS equivalent of the SQL migration.
 *
 * Given a list of messages and the set of sessions that already have a name
 * row, returns the name rows that should be inserted — i.e. what the SQL
 * INSERT … SELECT would produce.
 *
 * Tokenisation matches PostgreSQL exactly:
 *   string_to_array(trim(content), ' ')  — splits on a single space, preserves
 *   empty tokens from consecutive spaces; does NOT strip tab/newline.
 *   array_to_string(tokens[1:6], ' ')    — rejoins (empty tokens become gaps).
 *   regexp_replace(…, '[.!?]+$', '')     — strips trailing sentence punctuation.
 */
function runBackfillLogic(
  messages: Message[],
  existingSessions: Set<string>,
): SessionRow[] {
  // Collect eligible user messages per session.
  // Mirrors the inner SELECT … WHERE role='user' AND trim(content)<>''
  const bySession = new Map<string, Message[]>();

  for (const msg of messages) {
    if (!msg.sessionId) continue;
    if (msg.role !== "user") continue;
    if (msg.content === null || msg.content === undefined) continue;
    // PostgreSQL trim only removes ASCII spaces — tab/newline content is NOT blank
    if (pgTrim(msg.content) === "") continue;

    const list = bySession.get(msg.sessionId) ?? [];
    list.push(msg);
    bySession.set(msg.sessionId, list);
  }

  const result: SessionRow[] = [];

  for (const [sessionId, msgs] of bySession) {
    // WHERE NOT EXISTS … ON CONFLICT DO NOTHING
    if (existingSessions.has(sessionId)) continue;

    // DISTINCT ON (session_id) ORDER BY session_id, created_at ASC
    msgs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const earliest = msgs[0];

    // string_to_array(trim(content), ' ')  — space-split, preserves empty tokens
    const trimmed = pgTrim(earliest.content);
    const tokens = trimmed.split(" "); // empty tokens from consecutive spaces stay

    // [1:6] slice (PostgreSQL arrays are 1-indexed, but slice(0,6) is identical)
    const first6 = tokens.slice(0, 6);

    // array_to_string(…, ' ')
    const joined = first6.join(" ");

    // regexp_replace(…, '[.!?]+$', '')
    const name = joined.replace(/[.!?]+$/, "");

    result.push({ sessionId, projectId: earliest.projectId, name });
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function msg(
  overrides: Partial<Message> & Pick<Message, "sessionId" | "role" | "content">,
): Message {
  return {
    projectId: 1,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("backfill session name migration logic", () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it("assigns a name to a session with a user message and no existing row", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "Hello world" }),
    ];
    const rows = runBackfillLogic(messages, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("s1");
    expect(rows[0].name).toBe("Hello world");
  });

  it("truncates the name to the first 6 space-delimited tokens when the message is long", () => {
    const messages: Message[] = [
      msg({
        sessionId: "s1",
        role: "user",
        content: "one two three four five six seven eight",
      }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    expect(row.name).toBe("one two three four five six");
  });

  it("keeps the full name when the message has 6 or fewer words", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "Fix the login bug" }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    expect(row.name).toBe("Fix the login bug");
  });

  // ── Punctuation stripping ───────────────────────────────────────────────────

  it("strips a trailing period", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "Hello world." }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    expect(row.name).toBe("Hello world");
  });

  it("strips a trailing exclamation mark", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "Fix this now!" }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    expect(row.name).toBe("Fix this now");
  });

  it("strips a trailing question mark", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "How do I do this?" }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    expect(row.name).toBe("How do I do this");
  });

  it("strips multiple trailing punctuation characters", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "Are you sure?!" }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    expect(row.name).toBe("Are you sure");
  });

  it("preserves mid-sentence punctuation (commas inside tokens are kept)", () => {
    const messages: Message[] = [
      msg({
        sessionId: "s1",
        role: "user",
        // 8 words — first 6: "Fix login, signup, and profile pages"
        content: "Fix login, signup, and profile pages on mobile.",
      }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    expect(row.name).toBe("Fix login, signup, and profile pages");
  });

  // ── Earliest message wins ───────────────────────────────────────────────────

  it("uses the earliest user message when there are multiple", () => {
    const messages: Message[] = [
      msg({
        sessionId: "s1",
        role: "user",
        content: "Second message",
        createdAt: new Date("2024-01-01T01:00:00Z"),
      }),
      msg({
        sessionId: "s1",
        role: "user",
        content: "First message",
        createdAt: new Date("2024-01-01T00:00:00Z"),
      }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    expect(row.name).toBe("First message");
  });

  // ── Skip existing sessions ──────────────────────────────────────────────────

  it("does not insert a row for a session that already has an entry (ON CONFLICT guard)", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "Hello world" }),
    ];
    const rows = runBackfillLogic(messages, new Set(["s1"]));
    expect(rows).toHaveLength(0);
  });

  it("skips already-named sessions and names the new ones in the same pass", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "Already named" }),
      msg({ sessionId: "s2", role: "user", content: "Needs a name" }),
    ];
    const rows = runBackfillLogic(messages, new Set(["s1"]));
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("s2");
  });

  // ── Sessions with only assistant messages (edge case) ───────────────────────

  it("does not assign a name to a session that has only assistant messages", () => {
    const messages: Message[] = [
      msg({
        sessionId: "s1",
        role: "assistant",
        content: "Hello! How can I help you?",
      }),
    ];
    const rows = runBackfillLogic(messages, new Set());
    expect(rows).toHaveLength(0);
  });

  it("ignores assistant messages when searching for the earliest user message", () => {
    const messages: Message[] = [
      msg({
        sessionId: "s1",
        role: "assistant",
        content: "Earlier assistant reply",
        createdAt: new Date("2024-01-01T00:00:00Z"),
      }),
      msg({
        sessionId: "s1",
        role: "user",
        content: "Later user message",
        createdAt: new Date("2024-01-01T01:00:00Z"),
      }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    expect(row.name).toBe("Later user message");
  });

  // ── Sessions whose first user message is all ASCII spaces (edge case) ────────
  //
  // PostgreSQL WHERE trim(content)<>'' uses btrim which only strips ASCII space
  // (0x20). A message that is only spaces is excluded; one containing
  // non-space whitespace (\t, \n) is NOT excluded by the trim guard.

  it("does not assign a name when the only user message is all ASCII spaces", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "     " }),
    ];
    const rows = runBackfillLogic(messages, new Set());
    expect(rows).toHaveLength(0);
  });

  it("skips space-only messages and uses the next eligible one", () => {
    const messages: Message[] = [
      msg({
        sessionId: "s1",
        role: "user",
        content: "   ",
        createdAt: new Date("2024-01-01T00:00:00Z"),
      }),
      msg({
        sessionId: "s1",
        role: "user",
        content: "Real message",
        createdAt: new Date("2024-01-01T01:00:00Z"),
      }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    expect(row.name).toBe("Real message");
  });

  it("does not assign a name when every user message in the session is all spaces", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: " " }),
      msg({ sessionId: "s1", role: "user", content: "   " }),
    ];
    const rows = runBackfillLogic(messages, new Set());
    expect(rows).toHaveLength(0);
  });

  // ── Tab/newline-only content passes the space-trim guard (PostgreSQL semantics)
  //
  // PostgreSQL's trim() only removes space characters, so a message whose
  // content is '\t' or '\n' is NOT treated as blank by the WHERE clause.
  // Such a session receives a name row — the name itself will be the
  // whitespace character(s) left after space-trimming.

  it("assigns a name row when the only user message is tab-only (PostgreSQL trim keeps tabs)", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "\t" }),
    ];
    const rows = runBackfillLogic(messages, new Set());
    // PostgreSQL trim('\t') → '\t' (non-empty) → row is inserted
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("s1");
    expect(rows[0].name).toBe("\t");
  });

  it("assigns a name row when the content is spaces surrounding a tab (tabs survive trim)", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "  \t  " }),
    ];
    // pgTrim removes leading/trailing spaces → '\t' (non-empty)
    const rows = runBackfillLogic(messages, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("\t");
  });

  // ── Consecutive spaces preserve empty tokens (PostgreSQL semantics) ──────────
  //
  // string_to_array('word1  word2', ' ') → {word1,'',word2}
  // array_to_string({word1,'',word2}, ' ') → 'word1  word2'
  // The double space is preserved in the name — empty tokens are NOT filtered.

  it("preserves double spaces produced by consecutive spaces in the content", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "word1  word2" }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    // The empty token between the two spaces is kept → double space in name
    expect(row.name).toBe("word1  word2");
  });

  it("counts each consecutive-space gap as a token slot toward the 6-token limit", () => {
    // "a  b  c  d" → tokens: ['a','','b','','c','','d'] → first 6: ['a','','b','','c','']
    // joined → 'a  b  c '  then no trailing punct → 'a  b  c '
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "a  b  c  d" }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    expect(row.name).toBe("a  b  c ");
  });

  // ── Multiple sessions in one pass ───────────────────────────────────────────

  it("handles multiple sessions in a single pass", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "First session" }),
      msg({ sessionId: "s2", role: "user", content: "Second session" }),
      msg({
        sessionId: "s3",
        role: "assistant",
        content: "Assistant only — no name",
      }),
    ];
    const rows = runBackfillLogic(messages, new Set());
    expect(rows).toHaveLength(2);

    const bySession = Object.fromEntries(rows.map((r) => [r.sessionId, r]));
    expect(bySession["s1"].name).toBe("First session");
    expect(bySession["s2"].name).toBe("Second session");
    expect(bySession["s3"]).toBeUndefined();
  });

  // ── projectId is propagated ──────────────────────────────────────────────────

  it("carries the correct projectId from the message onto the inserted session row", () => {
    const messages: Message[] = [
      msg({ sessionId: "s1", role: "user", content: "Hello", projectId: 42 }),
    ];
    const [row] = runBackfillLogic(messages, new Set());
    expect(row.projectId).toBe(42);
  });
});
