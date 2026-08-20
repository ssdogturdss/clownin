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

const { mockDbExecute, mockDbSelect, mockDbInsert, mockDbDelete, mockRequireAuth, mockGetUser, nameStore } =
  vi.hoisted(() => {
    const mockDbExecute = vi.fn();

    // Shared in-memory store for conversation session names.
    // Written by mockDbInsert (simulating the upsert) and read dynamically by
    // queueDynamicSelect so that PATCH→GET round-trip tests have real state
    // transitions rather than pre-queued hardcoded values.
    const nameStore = new Map<string, string>();

    // db.select() is called multiple times per request with different query shapes:
    //   1. Project ownership check → .from().where().limit()
    //   2. Session existence check → .from().where().limit()   (rename route only)
    //   3. Name lookup             → .from().where()           (awaited directly)
    //   4. Preview per session     → .from().where().orderBy().limit()
    //
    // Each call to db.select() pops the next entry from selectQueue.
    // Entries can be pre-built chains (static) OR zero-argument factory functions
    // (dynamic — evaluated at query time so they can read from nameStore).
    type Chain = {
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise<unknown>;
      catch: (reject: (reason: unknown) => unknown) => Promise<unknown>;
      limit: (...args: unknown[]) => Promise<unknown>;
      orderBy: (...args: unknown[]) => { limit: (...args: unknown[]) => Promise<unknown> };
    };

    function makeChain(value: unknown): Chain {
      // A "thenable" object that resolves when awaited directly, and also
      // supports .limit() and .orderBy().limit() for chained calls.
      const thenable: Chain = {
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

    const selectQueue: Array<Chain | (() => unknown)> = [];

    // Expose helpers so tests can queue responses
    const mockDbSelect = vi.fn(() => {
      const entry = selectQueue.shift();
      if (!entry) throw new Error("db.select() called more times than expected");
      // Support factory functions: evaluated at query time → enables stateful lookups
      const chain = typeof entry === "function" ? makeChain(entry()) : entry;
      return { from: vi.fn(() => ({ where: vi.fn(() => chain) })) };
    });
    (mockDbSelect as unknown as { _queue: typeof selectQueue })._queue =
      selectQueue;
    (mockDbSelect as unknown as { _makeChain: typeof makeChain })._makeChain =
      makeChain;

    // Stateful insert mock: writes { sessionId → name } to nameStore when
    // .onConflictDoUpdate() is awaited, mirroring what the real upsert does.
    const mockDbInsert = vi.fn((_table: unknown) => {
      let capturedVals: { sessionId: string; projectId: number; name: string } | null = null;
      return {
        values: vi.fn((vals: { sessionId: string; projectId: number; name: string }) => {
          capturedVals = vals;
          return {
            onConflictDoUpdate: vi.fn(() => {
              if (capturedVals) nameStore.set(capturedVals.sessionId, capturedVals.name);
              return Promise.resolve();
            }),
          };
        }),
      };
    });

    const mockRequireAuth = vi.fn(
      (_req: unknown, _res: unknown, next: () => void) => next(),
    );
    const mockGetUser = vi.fn(() => ({
      userId: 1,
      email: "user@test.com",
      username: "testuser",
    }));

    // Stateful delete mock: when deleting from conversation_sessions (detected by
    // presence of a "name" column on the table object), remove the entry from
    // nameStore so that a subsequent GET for the same session sees no ghost name.
    const mockDbDelete = vi.fn((table: unknown) => ({
      where: vi.fn((condition: unknown) => {
        const tbl = table as Record<string, unknown>;
        if ("name" in tbl) {
          // conversationSessionsTable — extract the sessionId from the drizzle-orm
          // mock's and([{eq: sessionId}, {eq: projectId}]) shape and clear it.
          const cond = condition as { and?: Array<{ eq?: unknown }> };
          if (cond?.and?.[0]?.eq != null) {
            nameStore.delete(String(cond.and[0].eq));
          }
        }
        return Promise.resolve();
      }),
    }));

    return { mockDbExecute, mockDbSelect, mockDbInsert, mockDbDelete, mockRequireAuth, mockGetUser, nameStore };
  });

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    select: mockDbSelect,
    execute: mockDbExecute,
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    insert: mockDbInsert,
    transaction: vi.fn(),
    delete: mockDbDelete,
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

/**
 * Push a lazy factory onto the db.select() queue.
 * The factory is called at query-execution time, not at queue time.
 * Use this when the response depends on state written by a prior request
 * (e.g. what PATCH's upsert wrote to nameStore).
 */
function queueDynamicSelect(factory: () => unknown) {
  (mockDbSelect as unknown as SelectMock)._queue.push(
    factory as unknown as ReturnType<(typeof mockDbSelect extends { _makeChain: infer F } ? F : never)>,
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
  // Clear the stateful name store so round-trip tests start with a clean slate.
  nameStore.clear();
  // Re-apply the stateful implementation after clearAllMocks resets it.
  mockDbDelete.mockImplementation((table: unknown) => ({
    where: vi.fn((condition: unknown) => {
      const tbl = table as Record<string, unknown>;
      if ("name" in tbl) {
        const cond = condition as { and?: Array<{ eq?: unknown }> };
        if (cond?.and?.[0]?.eq != null) {
          nameStore.delete(String(cond.and[0].eq));
        }
      }
      return Promise.resolve();
    }),
  }));

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

  // ── Cross-project isolation ──────────────────────────────────────────────────

  it("does not leak a session name that belongs to a different project", async () => {
    // Scenario: session "sess-foreign" appears in conversation_messages for
    // project 5 (the queried project), but the conversation_sessions row for
    // that session_id carries project_id = 9 (a completely different project).
    //
    // The name-lookup query is scoped by BOTH session_id AND project_id, so
    // db.select() returns no matching row → name must be null.
    const FOREIGN_SESSION_ID = "sess-foreign-project9";

    // 1. Project ownership check → project 5 found
    queueSelect([{ id: 5 }]);
    // 2. Raw SQL aggregate → one session (its messages live in project 5)
    mockDbExecute.mockResolvedValueOnce({
      rows: [makeSessionRow(FOREIGN_SESSION_ID)],
    });
    // 3. Name lookup scoped to project 5 → no match because the
    //    conversation_sessions row belongs to project 9, not 5
    queueSelect([]);
    // 4. Preview message
    queueSelect([{ content: "Hello from a cross-project session" }]);

    const res = await request(app)
      .get("/api/projects/5/conversations")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      sessionId: FOREIGN_SESSION_ID,
      // Name must not bleed from the other project
      name: null,
      preview: "Hello from a cross-project session",
    });
  });

  it("only returns names for sessions that belong to the queried project", async () => {
    // Two sessions: one whose conversation_sessions row matches project 5,
    // one whose row belongs to project 7.  Only the first should have a name.
    const OWN_SESSION = "sess-owned-by-5";
    const FOREIGN_SESSION = "sess-owned-by-7";

    // 1. Project ownership
    queueSelect([{ id: 5 }]);
    // 2. Both sessions appear in conversation_messages for project 5
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        makeSessionRow(OWN_SESSION, { lastAt: LATER }),
        makeSessionRow(FOREIGN_SESSION, { lastAt: NOW }),
      ],
    });
    // 3. Name lookup filtered by project_id = 5 → only OWN_SESSION matches
    queueSelect([{ sessionId: OWN_SESSION, name: "My real session" }]);
    // 4. Preview for OWN_SESSION
    queueSelect([{ content: "Build a todo app" }]);
    // 5. Preview for FOREIGN_SESSION
    queueSelect([{ content: "Build a chat app" }]);

    const res = await request(app)
      .get("/api/projects/5/conversations")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const owned = res.body.find(
      (s: { sessionId: string }) => s.sessionId === OWN_SESSION,
    );
    const foreign = res.body.find(
      (s: { sessionId: string }) => s.sessionId === FOREIGN_SESSION,
    );

    expect(owned).toMatchObject({ name: "My real session" });
    // Foreign session's name must not appear — scoped-out by project_id filter
    expect(foreign).toMatchObject({ name: null });
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

// ── PATCH /api/projects/:id/conversations/:sessionId/name ──────────────────────

describe("PATCH /api/projects/:id/conversations/:sessionId/name", () => {
  // ── Validation guards ────────────────────────────────────────────────────────

  it("returns 400 for a non-numeric project id", async () => {
    const res = await request(app)
      .patch("/api/projects/not-a-number/conversations/sess-abc/name")
      .set(AUTH)
      .send({ name: "My session" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when name is missing", async () => {
    // No db calls needed — validation short-circuits before any query.
    const res = await request(app)
      .patch("/api/projects/5/conversations/sess-abc/name")
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "name is required" });
  });

  it("returns 400 when name is an empty string", async () => {
    const res = await request(app)
      .patch("/api/projects/5/conversations/sess-abc/name")
      .set(AUTH)
      .send({ name: "   " });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "name is required" });
  });

  // ── 404 guards ───────────────────────────────────────────────────────────────

  it("returns 404 when the project does not belong to the requesting user", async () => {
    // Ownership check returns no rows → 404
    queueSelect([]);

    const res = await request(app)
      .patch("/api/projects/99/conversations/sess-abc/name")
      .set(AUTH)
      .send({ name: "My session" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "project not found" });
  });

  it("returns 404 when the session does not belong to the project", async () => {
    // Ownership check → found; session check → no matching message row
    queueSelect([{ id: 5 }]);
    queueSelect([]);

    const res = await request(app)
      .patch("/api/projects/5/conversations/sess-unknown/name")
      .set(AUTH)
      .send({ name: "My session" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "session not found" });
  });

  // ── IDOR: cross-user rename attempt ─────────────────────────────────────────

  it("cannot rename a session that belongs to a different user's project (IDOR)", async () => {
    // Scenario: user A (userId=1, the authenticated user) sends a PATCH request
    // targeting project 99, which is owned by user B.
    //
    // The ownership check query must be scoped to BOTH the requested project ID
    // (99) AND the authenticated user's ID (1). We assert the where-clause
    // condition contains both values — so removing the userId filter from the
    // route would fail this test even if the mock happens to return [].
    //
    // The route finds no row and returns 404. db.insert is never called,
    // confirming user B's conversation_sessions row is completely untouched.
    const USER_A_ID = 1; // mockGetUser always returns userId: 1
    const USER_B_PROJECT_ID = 99;
    const USER_B_SESSION_ID = "sess-user-b-private";

    // Project ownership check returns no rows because user A does not own
    // project 99 — the route must stop here.
    queueSelect([]);

    const res = await request(app)
      .patch(`/api/projects/${USER_B_PROJECT_ID}/conversations/${USER_B_SESSION_ID}/name`)
      .set(AUTH) // authenticated as user A (userId=1)
      .send({ name: "Hijacked Name" });

    // Must be 404 — the project is not visible to user A
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "project not found" });

    // The upsert must never have been called — user B's session row is untouched
    expect(mockDbInsert).not.toHaveBeenCalled();

    // Critical: assert the ownership query was scoped to BOTH the target
    // project ID AND the authenticated user's ID.
    //
    // The route issues:
    //   db.select().from(projectsTable)
    //     .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
    //     .limit(1)
    //
    // The drizzle-orm mock translates this to:
    //   eq(col, val) → { eq: val }
    //   and(...args) → { and: args }
    //
    // So the where argument becomes: { and: [{ eq: 99 }, { eq: 1 }] }
    //
    // If a future change removes the userId filter, { eq: USER_A_ID } will not
    // appear in the conditions array and this assertion will catch it.
    const selectResult = mockDbSelect.mock.results[0]!.value as {
      from: { mock: { results: Array<{ value: { where: { mock: { calls: Array<[unknown]> } } } }> } };
    };
    const whereArg = selectResult.from.mock.results[0]!.value.where.mock.calls[0]![0];
    const conditions = (whereArg as { and: Array<{ eq: unknown }> }).and;
    expect(conditions).toContainEqual({ eq: USER_B_PROJECT_ID }); // project ID filter
    expect(conditions).toContainEqual({ eq: USER_A_ID });          // userId filter — proves ownership is checked
  });

  // ── Happy path: rename an existing session ────────────────────────────────────

  it("renames a session that already has a conversation_sessions row", async () => {
    const SESSION_ID = "sess-already-named";

    // 1. Project ownership → found
    queueSelect([{ id: 5 }]);
    // 2. Session existence check → found
    queueSelect([{ sessionId: SESSION_ID }]);
    // db.insert().values().onConflictDoUpdate() is mocked globally and resolves

    const res = await request(app)
      .patch(`/api/projects/5/conversations/${SESSION_ID}/name`)
      .set(AUTH)
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, name: "Updated Name" });
  });

  // ── Happy path: first-time name for a previously unnamed session ─────────────

  it("gives a first-time name to a session that had no conversation_sessions row", async () => {
    // This exercises the INSERT path of the upsert.
    // The route only checks that a conversation_messages row exists for the
    // session — it does not require a prior conversation_sessions row.
    const SESSION_ID = "sess-never-named";

    // 1. Project ownership → found
    queueSelect([{ id: 5 }]);
    // 2. Session existence check → found (message row exists)
    queueSelect([{ sessionId: SESSION_ID }]);
    // db.insert().values().onConflictDoUpdate() → succeeds (no prior row to conflict with)

    const res = await request(app)
      .patch(`/api/projects/5/conversations/${SESSION_ID}/name`)
      .set(AUTH)
      .send({ name: "Brand New Name" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, name: "Brand New Name" });
  });

  it("trims leading/trailing whitespace from the name", async () => {
    const SESSION_ID = "sess-trim-test";

    queueSelect([{ id: 5 }]);
    queueSelect([{ sessionId: SESSION_ID }]);

    const res = await request(app)
      .patch(`/api/projects/5/conversations/${SESSION_ID}/name`)
      .set(AUTH)
      .send({ name: "  Trimmed Name  " });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, name: "Trimmed Name" });
  });

  // ── End-to-end: rename then list ─────────────────────────────────────────────

  it("persists the new name so the next GET /conversations returns it", async () => {
    // This is the genuine stateful round-trip test.
    //
    // mockDbInsert writes the upserted name into `nameStore` when
    // .onConflictDoUpdate() is awaited.  The GET name-lookup queue entry is a
    // lazy factory that reads from `nameStore` at query-execution time — so
    // the value GET returns is exactly what PATCH wrote, not a hardcoded fixture.
    //
    // If PATCH stored the wrong name, wrote nothing, or used the wrong table,
    // the factory returns [] → name: null → the final assertion fails.
    const SESSION_ID = "sess-rename-then-list";
    const PROJECT_ID = 5;

    // ── PATCH: rename the session ──────────────────────────────────────────────
    queueSelect([{ id: PROJECT_ID }]);          // 1. Project ownership
    queueSelect([{ sessionId: SESSION_ID }]);   // 2. Session existence check

    const patchRes = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/conversations/${SESSION_ID}/name`)
      .set(AUTH)
      .send({ name: "Renamed Session" });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toMatchObject({ ok: true, name: "Renamed Session" });

    // Assert the upsert was called with the correct arguments
    expect(mockDbInsert).toHaveBeenCalledTimes(1);
    const valuesFn = mockDbInsert.mock.results[0]!.value.values;
    expect(valuesFn).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      name: "Renamed Session",
    });

    // ── GET: list sessions — the renamed session must appear with the new name ──
    queueSelect([{ id: PROJECT_ID }]);          // 1. Project ownership
    mockDbExecute.mockResolvedValueOnce({ rows: [makeSessionRow(SESSION_ID)] });
    // 2. Name lookup: factory reads from nameStore at query time.
    //    nameStore was populated by the PATCH upsert above.
    //    If PATCH wrote the wrong name (or nothing), the GET will return name: null
    //    and the assertion below will fail — proving the test is genuinely stateful.
    queueDynamicSelect(() => {
      const name = nameStore.get(SESSION_ID);
      return name ? [{ sessionId: SESSION_ID, name }] : [];
    });
    queueSelect([{ content: "Hello world" }]);  // 3. Preview message

    const getRes = await request(app)
      .get(`/api/projects/${PROJECT_ID}/conversations`)
      .set(AUTH);

    expect(getRes.status).toBe(200);
    expect(getRes.body).toHaveLength(1);
    expect(getRes.body[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: "Renamed Session",
    });
  });

  it("persists a first-time name for a previously unnamed session and surfaces it in GET", async () => {
    // Edge case: the session has never been renamed — no prior conversation_sessions row.
    // The upsert performs an INSERT (no conflict to update).
    // The GET name-lookup must return the newly written name, not null.
    //
    // nameStore starts empty (cleared in beforeEach).  PATCH writes to it via
    // onConflictDoUpdate.  The queueDynamicSelect factory for the GET name-lookup
    // reads from nameStore at query time — so a missing or incorrect write would
    // return [] → name: null → assertion fails.
    const SESSION_ID = "sess-first-name-then-list";
    const PROJECT_ID = 5;

    // ── PATCH ─────────────────────────────────────────────────────────────────
    queueSelect([{ id: PROJECT_ID }]);          // ownership
    queueSelect([{ sessionId: SESSION_ID }]);   // session existence

    const patchRes = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/conversations/${SESSION_ID}/name`)
      .set(AUTH)
      .send({ name: "First Ever Name" });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toMatchObject({ ok: true, name: "First Ever Name" });

    // Assert the upsert was called with the correct arguments
    expect(mockDbInsert).toHaveBeenCalledTimes(1);
    const valuesFn = mockDbInsert.mock.results[0]!.value.values;
    expect(valuesFn).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      name: "First Ever Name",
    });

    // ── GET ───────────────────────────────────────────────────────────────────
    queueSelect([{ id: PROJECT_ID }]);          // ownership
    mockDbExecute.mockResolvedValueOnce({ rows: [makeSessionRow(SESSION_ID)] });
    // Name lookup reads from nameStore — populated by PATCH's insert above
    queueDynamicSelect(() => {
      const name = nameStore.get(SESSION_ID);
      return name ? [{ sessionId: SESSION_ID, name }] : [];
    });
    queueSelect([{ content: "First message" }]); // preview

    const getRes = await request(app)
      .get(`/api/projects/${PROJECT_ID}/conversations`)
      .set(AUTH);

    expect(getRes.status).toBe(200);
    expect(getRes.body).toHaveLength(1);
    expect(getRes.body[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: "First Ever Name",
    });
  });

  // ── DELETE: legacy sentinel skips conversation_sessions cleanup ──────────────

  it("deletes only messages (not sessions) and returns { ok: true } when sessionId is 'legacy'", async () => {
    // "legacy" is the sentinel for pre-migration rows where session_id IS NULL.
    // These rows have no conversation_sessions entry, so the handler must:
    //   1. Delete from conversationMessagesTable  (one db.delete() call)
    //   2. Skip the conversationSessionsTable delete entirely
    // This test asserts exactly one db.delete() call was made.
    const PROJECT_ID = 5;

    // Project ownership check → found
    queueSelect([{ id: PROJECT_ID }]);

    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/conversations/legacy`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    // Exactly one delete — messages only; sessions table must not be touched.
    expect(mockDbDelete).toHaveBeenCalledTimes(1);
    // The single call must target conversationMessagesTable, which has no "name"
    // column in our mock. conversationSessionsTable has "name" — its absence here
    // proves the sessions-table branch was skipped.
    const deletedTable = mockDbDelete.mock.calls[0]![0] as Record<string, unknown>;
    expect(deletedTable).not.toHaveProperty("name");
  });

  it("returns name: null after delete-then-recreate (no ghost name)", async () => {
    // Scenario: a session is named via PATCH, then deleted via DELETE.
    // If the same session_id is re-used (e.g. a retry/reconnect flow), the GET
    // must NOT return the old name — it should be null.
    //
    // The DELETE handler must delete the conversation_sessions row so the name
    // cannot reappear.  The mockDbDelete mock clears nameStore for
    // conversationSessionsTable, mirroring what the real DELETE does to the DB.
    const SESSION_ID = "sess-ghost-name-test";
    const PROJECT_ID = 5;

    // ── PATCH: name the session ───────────────────────────────────────────────
    queueSelect([{ id: PROJECT_ID }]);          // ownership
    queueSelect([{ sessionId: SESSION_ID }]);   // session existence

    const patchRes = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/conversations/${SESSION_ID}/name`)
      .set(AUTH)
      .send({ name: "Soon To Be Deleted" });

    expect(patchRes.status).toBe(200);
    expect(nameStore.get(SESSION_ID)).toBe("Soon To Be Deleted");

    // ── DELETE: remove the session ────────────────────────────────────────────
    queueSelect([{ id: PROJECT_ID }]);          // ownership

    const deleteRes = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/conversations/${SESSION_ID}`)
      .set(AUTH);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toMatchObject({ ok: true });

    // The session name must have been cleared by the DELETE handler so a
    // re-created session with the same ID cannot inherit the old name.
    expect(nameStore.get(SESSION_ID)).toBeUndefined();

    // ── GET: simulate re-creation with same session_id ────────────────────────
    queueSelect([{ id: PROJECT_ID }]);          // ownership
    mockDbExecute.mockResolvedValueOnce({
      rows: [makeSessionRow(SESSION_ID)],       // session exists again (re-created)
    });
    // Name lookup reads from nameStore — must be empty after DELETE
    queueDynamicSelect(() => {
      const name = nameStore.get(SESSION_ID);
      return name ? [{ sessionId: SESSION_ID, name }] : [];
    });
    queueSelect([{ content: "Starting over" }]); // preview

    const getRes = await request(app)
      .get(`/api/projects/${PROJECT_ID}/conversations`)
      .set(AUTH);

    expect(getRes.status).toBe(200);
    expect(getRes.body).toHaveLength(1);
    expect(getRes.body[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: null,
    });
  });
});
