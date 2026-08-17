/**
 * Tests for GET /api/admin/session-name-coverage
 *
 * All external I/O is mocked:
 *   - @workspace/db  → vi.mock so the real DB is never touched
 *   - drizzle-orm    → lightweight stubs
 *   - ../../lib/auth → stubs requireAuth + getUser so JWT is bypassed
 *   - node-cron      → prevent real cron jobs from starting
 *
 * Key behaviour verified:
 *   - 401 when not authenticated
 *   - 403 when authenticated but not an admin
 *   - Returns { total, named, unnamed } driven from conversation_messages
 *   - named < total when some sessions have no conversation_sessions row
 *     (i.e. the backfill migration did not run for them)
 *   - named === total when every eligible session has a name
 *   - total === 0 when there are no eligible messages
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ── Hoisted mock state ────────────────────────────────────────────────────────

const {
  mockDbSelect,
  mockDbFrom,
  mockDbLeftJoin,
  mockDbWhere,
  mockRequireAuth,
  mockGetUser,
} = vi.hoisted(() => {
  // .select().from().leftJoin().where() chain
  const mockDbWhere = vi.fn();
  const mockDbLeftJoin = vi.fn(() => ({ where: mockDbWhere }));
  const mockDbFrom = vi.fn(() => ({
    where: mockDbWhere,
    leftJoin: mockDbLeftJoin,
  }));
  const mockDbSelect = vi.fn(() => ({ from: mockDbFrom }));

  // Auth stubs
  const mockRequireAuth = vi.fn(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  const mockGetUser = vi.fn(() => ({
    userId: 1,
    email: "admin@test.com",
    username: "admin",
  }));

  return {
    mockDbSelect,
    mockDbFrom,
    mockDbLeftJoin,
    mockDbWhere,
    mockRequireAuth,
    mockGetUser,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    select: mockDbSelect,
    // admin route also uses update/insert via other routes loaded at import time
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
  desc: (_col: unknown) => ({ desc: true }),
  count: () => ({ count: true }),
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

// Set numeric ADMIN_USER_IDS so requireAdmin resolves without a DB lookup.
process.env.ADMIN_USER_IDS = "1";

// Import app after mocks are in place.
const { default: app } = await import("../../app.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const AUTH = { Authorization: "Bearer test-token" };

/** Make the DB return the given coverage row from the single-query endpoint. */
function mockCoverage(total: number, named: number) {
  mockDbWhere.mockResolvedValueOnce([{ total, named }]);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated as admin userId=1
  mockRequireAuth.mockImplementation(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  mockGetUser.mockReturnValue({
    userId: 1,
    email: "admin@test.com",
    username: "admin",
  });
  // Default select chain returns empty
  mockDbWhere.mockResolvedValue([]);
  mockDbLeftJoin.mockImplementation(() => ({ where: mockDbWhere }));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/admin/session-name-coverage", () => {
  // ── Auth guards ─────────────────────────────────────────────────────────────

  it("returns 401 when not authenticated", async () => {
    mockRequireAuth.mockImplementation(
      (
        _req: unknown,
        res: { status: (n: number) => { json: (b: unknown) => void } },
      ) => {
        res.status(401).json({ error: "Unauthorized" });
      },
    );

    const res = await request(app)
      .get("/api/admin/session-name-coverage")
      .expect(401);

    expect(res.body.error).toMatch(/unauthorized/i);
  });

  it("returns 403 when authenticated but not an admin", async () => {
    // Non-admin user (userId=99 not in ADMIN_USER_IDS=1)
    mockGetUser.mockReturnValue({
      userId: 99,
      email: "user@test.com",
      username: "regular",
    });

    const res = await request(app)
      .get("/api/admin/session-name-coverage")
      .set(AUTH)
      .expect(403);

    expect(res.body.error).toMatch(/forbidden/i);
  });

  // ── Happy-path coverage ──────────────────────────────────────────────────────

  it("returns { total: 0, named: 0, unnamed: 0 } when there are no eligible messages", async () => {
    mockCoverage(0, 0);

    const res = await request(app)
      .get("/api/admin/session-name-coverage")
      .set(AUTH)
      .expect(200);

    expect(res.body).toEqual({ total: 0, named: 0, unnamed: 0 });
  });

  it("returns full coverage when every eligible session has a name", async () => {
    mockCoverage(5, 5);

    const res = await request(app)
      .get("/api/admin/session-name-coverage")
      .set(AUTH)
      .expect(200);

    expect(res.body).toEqual({ total: 5, named: 5, unnamed: 0 });
  });

  it("counts sessions with a conversation_messages row but no conversation_sessions row as unnamed", async () => {
    // 3 eligible sessions exist in messages; only 1 has a sessions row with a name.
    // This is the key scenario: if the migration never ran, named=0 and unnamed=total.
    mockCoverage(3, 1);

    const res = await request(app)
      .get("/api/admin/session-name-coverage")
      .set(AUTH)
      .expect(200);

    expect(res.body).toEqual({ total: 3, named: 1, unnamed: 2 });
  });

  it("reports all sessions as unnamed when the migration has not run (named=0)", async () => {
    mockCoverage(7, 0);

    const res = await request(app)
      .get("/api/admin/session-name-coverage")
      .set(AUTH)
      .expect(200);

    expect(res.body).toEqual({ total: 7, named: 0, unnamed: 7 });
  });

  it("computes unnamed correctly as total minus named", async () => {
    mockCoverage(10, 6);

    const res = await request(app)
      .get("/api/admin/session-name-coverage")
      .set(AUTH)
      .expect(200);

    expect(res.body.unnamed).toBe(4);
    expect(res.body.total - res.body.named).toBe(res.body.unnamed);
  });

  it("handles a null/undefined DB row gracefully (returns all zeros)", async () => {
    // Simulate DB returning an empty array (no row from the aggregate query)
    mockDbWhere.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/api/admin/session-name-coverage")
      .set(AUTH)
      .expect(200);

    expect(res.body).toEqual({ total: 0, named: 0, unnamed: 0 });
  });

  // ── Query shape ──────────────────────────────────────────────────────────────

  it("drives the query from conversation_messages (left-joins to conversation_sessions)", async () => {
    mockCoverage(2, 2);

    await request(app)
      .get("/api/admin/session-name-coverage")
      .set(AUTH)
      .expect(200);

    // The select chain must include a leftJoin (not a direct scan of conversation_sessions).
    expect(mockDbLeftJoin).toHaveBeenCalledOnce();

    // from() must be called with conversationMessagesTable (the population source).
    expect(mockDbFrom).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session_id", role: "role" }),
    );
  });
});
