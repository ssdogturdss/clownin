/**
 * Tests for GET /api/projects/:id/conversations (sessions list)
 *
 * All external I/O is mocked:
 *   - @workspace/db  → vi.mock so the real DB is never touched
 *   - drizzle-orm    → lightweight stubs
 *   - ../../lib/auth → stubs requireAuth + getUser so JWT is bypassed
 *   - node-cron      → prevent real cron jobs from starting
 *
 * Key behaviour verified:
 *   - Sessions whose name comes from a conversation_sessions row (backfill)
 *     are returned with that name in the API response
 *   - Sessions that have no conversation_sessions row still appear with name: null
 *   - Multiple sessions where only some have names are all returned correctly
 *   - A project with no sessions returns an empty array
 *   - 401 when unauthenticated, 404 when project not owned by requesting user
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ── Hoisted mock state ────────────────────────────────────────────────────────

const { mockDbExecute, mockDbSelect, mockRequireAuth, mockGetUser } =
  vi.hoisted(() => {
    const mockDbExecute = vi.fn();

    // db.select() is called multiple times per request with different query shapes:
    //   1. Project ownership check → .from().where().limit()
    //   2. Name lookup             → .from().where()           (awaited directly)
    //   3. Preview per session     → .from().where().orderBy().limit()
    //
    // Each call to db.select() pops the next chain factory from selectQueue so
    // tests can control every response independently.
    const selectQueue: Array<ReturnType<typeof makeChain>> = [];
    function makeChain(value: unknown) {
      // A "thenable" object that resolves when awaited directly, and also
      // supports .limit() and .orderBy().limit() for chained calls.
      const thenable = {
        then: (
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown,
        ) => Promise.resolve(value).then(resolve, reject),
        catch: (reject: (e: unknown) => unknown) =>
          Promise.resolve(value).catch(reject),
        limit: vi.fn().mockResolvedValue(value),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(value),
        }),
      };
      return thenable;
    }

    // Expose helpers so tests can queue responses
    const mockDbSelect = vi.fn(() => {
      const chain = selectQueue.shift();
      if (!chain) throw new Error("db.select() called more times than expected");
      return { from: vi.fn(() => ({ where: vi.fn(() => chain) })) };
    });
    (mockDbSelect as unknown as { _queue: typeof selectQueue })._queue =
      selectQueue;
    (mockDbSelect as unknown as { _makeChain: typeof makeChain })._makeChain =
      makeChain;

    const mockRequireAuth = vi.fn(
      (_req: unknown, _res: unknown, next: () => void) => next(),
    );
    const mockGetUser = vi.fn(() => ({
      userId: 1,
      email: "user@test.com",
      username: "testuser",
    }));

    return { mockDbExecute, mockDbSelect, mockRequireAuth, mockGetUser };
  });

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    select: mockDbSelect,
    execute: mockDbExecute,
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    insert: vi.fn(() => ({ values: vi.fn() })),
    transaction: vi.fn(),
    delete: vi.fn(() => ({ where: vi.fn() })),
  },
  usersTable: {
    id: "id",
    username: "username",
    email: "email",
    subscriptionTier: "subscriptionTier",
    dailyMessageCount: "dailyMessageCount",
    dailyMessageDate: "dailyMessageDate",
    createdAt: "createdAt",
  },
  projectsTable: { id: "id", userId: "userId", updatedAt: "updatedAt" },
  projectFilesTable: { projectId: "projectId" },
  projectEnvVarsTable: { projectId: "projectId" },
  conversationMessagesTable: {
    sessionId: "session_id",
    projectId: "project_id",
    role: "role",
    content: "content",
    createdAt: "created_at",
  },
  conversationSessionsTable: {
    sessionId: "session_id",
    projectId: "project_id",
    name: "name",
    createdAt: "created_at",
  },
  promoCodesTable: { id: "id", code: "code" },
  promoCodeRedemptionsTable: { id: "id" },
  providerConfigsTable: { provider: "provider" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, val: unknown) => ({ eq: val }),
  and: (...args: unknown[]) => ({ and: args }),
  or: (...args: unknown[]) => ({ or: args }),
  isNull: (_col: unknown) => ({ isNull: true }),
  isNotNull: (_col: unknown) => ({ isNotNull: true }),
  gt: (_col: unknown, val: unknown) => ({ gt: val }),
  lt: (_col: unknown, val: unknown) => ({ lt: val }),
  asc: (_col: unknown) => ({ asc: true }),
  desc: (_col: unknown) => ({ desc: true }),
  count: () => ({ count: true }),
  inArray: (_col: unknown, vals: unknown) => ({ inArray: vals }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: String(strings),
    values,
  }),
}));

vi.mock("../../lib/auth.js", () => ({
  requireAuth: mockRequireAuth,
  getUser: mockGetUser,
}));

vi.mock("node-cron", () => ({
  default: { schedule: vi.fn() },
}));

process.env.ADMIN_USER_IDS = "1";

// Import app after all mocks are in place.
const { default: app } = await import("../../app.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const AUTH = { Authorization: "Bearer test-token" };

type SelectMock = typeof mockDbSelect & {
  _queue: Array<unknown>;
  _makeChain: (value: unknown) => unknown;
};

/** Push a chain that resolves to `value` onto the db.select() queue. */
function queueSelect(value: unknown) {
  (mockDbSelect as unknown as SelectMock)._queue.push(
    (mockDbSelect as unknown as SelectMock)._makeChain(value),
  );
}

const NOW = new Date("2024-01-15T12:00:00Z");
const LATER = new Date("2024-01-15T13:00:00Z");

/** Build a raw session row as returned by db.execute(). */
function makeSessionRow(
  sessionId: string,
  opts?: { messageCount?: number; startedAt?: Date; lastAt?: Date },
) {
  return {
    session_id: sessionId,
    message_count: String(opts?.messageCount ?? 3),
    started_at: opts?.startedAt ?? NOW,
    last_at: opts?.lastAt ?? LATER,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  (mockDbSelect as unknown as SelectMock)._queue.length = 0;

  mockRequireAuth.mockImplementation(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  mockGetUser.mockReturnValue({
    userId: 1,
    email: "user@test.com",
    username: "testuser",
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/projects/:id/conversations", () => {
  // ── Auth guards ─────────────────────────────────────────────────────────────

  it("returns 401 when the user is not authenticated", async () => {
    mockRequireAuth.mockImplementation(
      (_req: unknown, res: { status: (n: number) => { json: (o: unknown) => void } }, _next: unknown) => {
        res.status(401).json({ error: "unauthorized" });
      },
    );

    const res = await request(app).get("/api/projects/42/conversations");
    expect(res.status).toBe(401);
  });

  it("returns 400 for a non-numeric project id", async () => {
    const res = await request(app)
      .get("/api/projects/not-a-number/conversations")
      .set(AUTH);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the project does not belong to the requesting user", async () => {
    // Project ownership check returns no rows → 404
    queueSelect([]);

    const res = await request(app)
      .get("/api/projects/99/conversations")
      .set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "project not found" });
  });

  // ── Happy path: no sessions ──────────────────────────────────────────────────

  it("returns an empty array when a project has no sessions", async () => {
    // Project ownership check → found
    queueSelect([{ id: 7 }]);
    // Raw SQL aggregate → no sessions
    mockDbExecute.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/api/projects/7/conversations")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  // ── Backfill case: session WITH a name row ───────────────────────────────────

  it("returns the backfill name for a session that has a conversation_sessions row", async () => {
    const SESSION_ID = "sess-backfilled-abc";

    // 1. Project ownership
    queueSelect([{ id: 5 }]);
    // 2. Raw SQL session aggregate
    mockDbExecute.mockResolvedValueOnce({
      rows: [makeSessionRow(SESSION_ID)],
    });
    // 3. Name lookup (conversation_sessions) — has a row from the backfill
    queueSelect([{ sessionId: SESSION_ID, name: "My Backfilled Session" }]);
    // 4. Preview message for that session
    queueSelect([{ content: "Hello, build me a todo app" }]);

    const res = await request(app)
      .get("/api/projects/5/conversations")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: "My Backfilled Session",
      preview: "Hello, build me a todo app",
      messageCount: 3,
    });
  });

  // ── Edge: session WITHOUT a name row ────────────────────────────────────────

  it("returns name: null for a session that has no conversation_sessions row", async () => {
    const SESSION_ID = "sess-no-name-xyz";

    // 1. Project ownership
    queueSelect([{ id: 5 }]);
    // 2. Raw SQL session aggregate
    mockDbExecute.mockResolvedValueOnce({
      rows: [makeSessionRow(SESSION_ID)],
    });
    // 3. Name lookup → no row for this session
    queueSelect([]);
    // 4. Preview message
    queueSelect([{ content: "Write a snake game" }]);

    const res = await request(app)
      .get("/api/projects/5/conversations")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: null,
      preview: "Write a snake game",
    });
  });

  // ── Mixed: some sessions named, some not ────────────────────────────────────

  it("returns the correct name (or null) for each session in a mixed list", async () => {
    const NAMED_ID = "sess-named-111";
    const UNNAMED_ID = "sess-unnamed-222";

    // 1. Project ownership
    queueSelect([{ id: 5 }]);
    // 2. Raw SQL: two sessions, newest first
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        makeSessionRow(NAMED_ID, { lastAt: LATER }),
        makeSessionRow(UNNAMED_ID, { lastAt: NOW }),
      ],
    });
    // 3. Name lookup → only the first session has a row
    queueSelect([{ sessionId: NAMED_ID, name: "Project planning" }]);
    // 4. Preview for first session
    queueSelect([{ content: "Plan my project" }]);
    // 5. Preview for second session
    queueSelect([{ content: "Show me a hello world" }]);

    const res = await request(app)
      .get("/api/projects/5/conversations")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const named = res.body.find(
      (s: { sessionId: string }) => s.sessionId === NAMED_ID,
    );
    const unnamed = res.body.find(
      (s: { sessionId: string }) => s.sessionId === UNNAMED_ID,
    );

    expect(named).toMatchObject({ name: "Project planning", sessionId: NAMED_ID });
    expect(unnamed).toMatchObject({ name: null, sessionId: UNNAMED_ID });
  });

  // ── Preview truncation ───────────────────────────────────────────────────────

  it("truncates the preview to 120 characters", async () => {
    const SESSION_ID = "sess-long-preview";
    const longMessage = "a".repeat(200);

    queueSelect([{ id: 5 }]);
    mockDbExecute.mockResolvedValueOnce({
      rows: [makeSessionRow(SESSION_ID)],
    });
    queueSelect([{ sessionId: SESSION_ID, name: "Verbose session" }]);
    queueSelect([{ content: longMessage }]);

    const res = await request(app)
      .get("/api/projects/5/conversations")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body[0].preview).toHaveLength(120);
  });

  // ── Session with no user messages ────────────────────────────────────────────

  it("returns an empty preview when a session has no user messages", async () => {
    const SESSION_ID = "sess-no-user-msg";

    queueSelect([{ id: 5 }]);
    mockDbExecute.mockResolvedValueOnce({
      rows: [makeSessionRow(SESSION_ID)],
    });
    queueSelect([{ sessionId: SESSION_ID, name: "Silent session" }]);
    // No preview row
    queueSelect([]);

    const res = await request(app)
      .get("/api/projects/5/conversations")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      sessionId: SESSION_ID,
      preview: "",
      name: "Silent session",
    });
  });

  // ── Timestamps are ISO strings ───────────────────────────────────────────────

  it("returns startedAt and lastAt as ISO 8601 strings", async () => {
    const SESSION_ID = "sess-timestamps";
    const start = new Date("2024-03-01T09:00:00Z");
    const last = new Date("2024-03-01T10:30:00Z");

    queueSelect([{ id: 5 }]);
    mockDbExecute.mockResolvedValueOnce({
      rows: [makeSessionRow(SESSION_ID, { startedAt: start, lastAt: last })],
    });
    queueSelect([]);
    queueSelect([{ content: "First message" }]);

    const res = await request(app)
      .get("/api/projects/5/conversations")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body[0].startedAt).toBe(start.toISOString());
    expect(res.body[0].lastAt).toBe(last.toISOString());
  });
});
