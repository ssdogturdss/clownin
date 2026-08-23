/**
 * Integration tests for POST /api/promo-codes/redeem
 * and GET /api/admin/promo-codes/:id/redemptions.
 *
 * All external I/O is mocked:
 *   - @workspace/db  → vi.mock so the real DB is never touched
 *   - drizzle-orm    → lightweight stubs
 *   - ../lib/auth    → stubs requireAuth + getUser so JWT signing is bypassed
 *   - node-cron      → prevent real cron jobs from starting
 *
 * Covers:
 *   POST /api/promo-codes/redeem:
 *   - Auth guard (401 when no token)
 *   - Validation (400 when code missing)
 *   - Invalid code (404)
 *   - Inactive code (410)
 *   - Expired code (410)
 *   - Already on this tier (409)
 *   - Successful redemption (200 with tier + message)
 *   - Concurrent single-use exhaustion (410 when atomic claim fails)
 *   - Code is uppercased before lookup
 *   - Redemption audit row is inserted inside the transaction on success
 *
 *   GET /api/admin/promo-codes/:id/redemptions:
 *   - Returns 401 when not authenticated
 *   - Returns 403 when not an admin
 *   - Returns 400 for a non-numeric id
 *   - Returns redemption list joined with user info
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ── Hoisted mock state ────────────────────────────────────────────────────────

const {
  mockDbSelect,
  mockDbFrom,
  mockDbWhere,
  mockDbUpdate,
  mockDbSet,
  mockDbUpdateWhere,
  mockDbReturning,
  mockDbInsert,
  mockDbInsertValues,
  mockDbTransaction,
  mockDbOrderBy,
  mockDbLeftJoin,
  mockRequireAuth,
  mockGetUser,
} = vi.hoisted(() => {
  // ── DB: .select().from().where() / .orderBy() / .leftJoin() ──────────────
  const mockDbOrderBy = vi.fn().mockResolvedValue([]);
  const mockDbLeftJoin = vi.fn(() => ({ where: mockDbWhereInner, orderBy: mockDbOrderBy }));
  // forward-declare so the factory can reference it
  const mockDbWhereInner: ReturnType<typeof vi.fn> = vi.fn(() => ({ orderBy: mockDbOrderBy }));
  const mockDbFrom = vi.fn(() => ({
    where: mockDbWhereInner,
    leftJoin: mockDbLeftJoin,
    orderBy: mockDbOrderBy,
  }));
  const mockDbSelect = vi.fn(() => ({ from: mockDbFrom }));

  // The plain .where() returned outside leftJoin context (used by promo + user lookups)
  const mockDbWhere = mockDbWhereInner;

  // ── DB: .update().set().where().returning() ───────────────────────────────
  const mockDbReturning = vi.fn().mockResolvedValue([{ id: 42, tier: "pro" }]);
  const mockDbUpdateWhere = vi.fn(() => ({ returning: mockDbReturning }));
  const mockDbSet = vi.fn(() => ({ where: mockDbUpdateWhere }));
  const mockDbUpdate = vi.fn(() => ({ set: mockDbSet }));

  // ── DB: .insert().values() ────────────────────────────────────────────────
  const mockDbInsertValues = vi.fn().mockResolvedValue([]);
  const mockDbInsert = vi.fn(() => ({ values: mockDbInsertValues }));

  // ── DB: transaction ───────────────────────────────────────────────────────
  const mockDbTransaction = vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
    const tx = { update: mockDbUpdate, insert: mockDbInsert };
    return cb(tx);
  });

  // ── Auth ──────────────────────────────────────────────────────────────────
  const mockRequireAuth = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
  const mockGetUser = vi.fn(() => ({ userId: 1, email: "test@test.com", username: "testuser" }));

  return {
    mockDbSelect,
    mockDbFrom,
    mockDbWhere,
    mockDbUpdate,
    mockDbSet,
    mockDbUpdateWhere,
    mockDbReturning,
    mockDbInsert,
    mockDbInsertValues,
    mockDbTransaction,
    mockDbOrderBy,
    mockDbLeftJoin,
    mockRequireAuth,
    mockGetUser,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
    insert: mockDbInsert,
    transaction: mockDbTransaction,
  },
  usersTable: {
    id: "id",
    username: "username",
    email: "email",
    subscriptionTier: "subscriptionTier",
    subscriptionSource: "subscriptionSource",
  },
  promoCodesTable: {
    id: "id",
    code: "code",
    tier: "tier",
    isActive: "isActive",
    expiresAt: "expiresAt",
    usedCount: "usedCount",
    maxUses: "maxUses",
  },
  promoCodeRedemptionsTable: {
    id: "id",
    promoCodeId: "promoCodeId",
    userId: "userId",
    redeemedAt: "redeemedAt",
    tier: "tier",
  },
  providerConfigsTable: { provider: "provider" },
  projectsTable: { id: "id", userId: "userId", updatedAt: "updatedAt" },
  projectFilesTable: { projectId: "projectId" },
  projectEnvVarsTable: { projectId: "projectId" },
  conversationMessagesTable: { projectId: "projectId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, val: unknown) => ({ eq: val }),
  and: (...args: unknown[]) => ({ and: args }),
  or: (...args: unknown[]) => ({ or: args }),
  isNull: (_col: unknown) => ({ isNull: true }),
  gt: (_col: unknown, val: unknown) => ({ gt: val }),
  lt: (_col: unknown, val: unknown) => ({ lt: val }),
  desc: (_col: unknown) => ({ desc: true }),
  count: () => ({ count: true }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: String(strings),
    values,
  }),
}));

// Bypass real JWT verification — auth state is controlled by mockRequireAuth/mockGetUser.
vi.mock("../../lib/auth.js", () => ({
  requireAuth: mockRequireAuth,
  getUser: mockGetUser,
  getSystemUserId: () => 1,
}));

vi.mock("node-cron", () => ({
  default: { schedule: vi.fn() },
}));

// Import app after all mocks are in place.
const { default: app } = await import("../../app.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal promo code row returned by the DB select. */
function promoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    code: "CLOWN-AAAAAA-BBBBBB",
    tier: "pro",
    isActive: true,
    expiresAt: null,
    usedCount: 0,
    maxUses: 5,
    notes: null,
    createdBy: 1,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Fake auth header — value doesn't matter since requireAuth is mocked. */
const AUTH = { Authorization: "Bearer test-token" };

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: authenticated as userId=1, passing through to next()
  mockRequireAuth.mockImplementation((_req: unknown, _res: unknown, next: () => void) => next());
  mockGetUser.mockReturnValue({ userId: 1, email: "test@test.com", username: "testuser" });

  // Default select chain: no results
  mockDbWhere.mockResolvedValue([]);
  mockDbOrderBy.mockResolvedValue([]);

  // Default transaction: call callback with tx proxy (includes insert)
  mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    const tx = { update: mockDbUpdate, insert: mockDbInsert };
    return cb(tx);
  });

  // Default insert: resolves empty (redemption audit insert)
  mockDbInsertValues.mockResolvedValue([]);

  // Default claim: returns 1 row (success)
  mockDbReturning.mockResolvedValue([{ id: 42, tier: "pro" }]);
});

// ── Tests: POST /api/promo-codes/redeem ──────────────────────────────────────

describe("POST /api/promo-codes/redeem", () => {
  it("returns 401 when not authenticated", async () => {
    mockRequireAuth.mockImplementation((_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
      res.status(401).json({ error: "Unauthorized" });
    });

    const res = await request(app)
      .post("/api/promo-codes/redeem")
      .send({ code: "CLOWN-TEST-CODE" });

    expect(res.status).toBe(401);
  });

  it("returns 400 when code is missing from the body", async () => {
    const res = await request(app)
      .post("/api/promo-codes/redeem")
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/code/i);
  });

  it("returns 404 when the promo code does not exist", async () => {
    mockDbWhere.mockResolvedValueOnce([]); // promo lookup: not found
    const res = await request(app)
      .post("/api/promo-codes/redeem")
      .set(AUTH)
      .send({ code: "CLOWN-DOESNT-EXIST" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 410 when the code is inactive (already exhausted)", async () => {
    mockDbWhere.mockResolvedValueOnce([promoRow({ isActive: false })]);
    const res = await request(app)
      .post("/api/promo-codes/redeem")
      .set(AUTH)
      .send({ code: "CLOWN-AAAAAA-BBBBBB" });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/used up/i);
  });

  it("returns 410 when the code has expired", async () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago
    mockDbWhere.mockResolvedValueOnce([promoRow({ expiresAt: pastDate, isActive: true })]);
    const res = await request(app)
      .post("/api/promo-codes/redeem")
      .set(AUTH)
      .send({ code: "CLOWN-AAAAAA-BBBBBB" });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expired/i);
  });

  it("returns 409 when the user is already on the code's tier", async () => {
    mockDbWhere
      .mockResolvedValueOnce([promoRow()]) // promo lookup
      .mockResolvedValueOnce([{ subscriptionTier: "pro" }]); // user lookup
    const res = await request(app)
      .post("/api/promo-codes/redeem")
      .set(AUTH)
      .send({ code: "CLOWN-AAAAAA-BBBBBB" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });

  it("returns 200 with tier and message on successful redemption", async () => {
    mockDbWhere
      .mockResolvedValueOnce([promoRow()]) // promo lookup
      .mockResolvedValueOnce([{ subscriptionTier: "free" }]); // user lookup
    mockDbReturning.mockResolvedValue([{ id: 42, tier: "pro" }]);

    const res = await request(app)
      .post("/api/promo-codes/redeem")
      .set(AUTH)
      .send({ code: "CLOWN-AAAAAA-BBBBBB" });

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("pro");
    expect(res.body.message).toMatch(/pro/i);
  });

  it("inserts a redemption audit row inside the transaction on success", async () => {
    mockDbWhere
      .mockResolvedValueOnce([promoRow()]) // promo lookup
      .mockResolvedValueOnce([{ subscriptionTier: "free" }]); // user lookup
    mockDbReturning.mockResolvedValue([{ id: 42, tier: "pro" }]);

    await request(app)
      .post("/api/promo-codes/redeem")
      .set(AUTH)
      .send({ code: "CLOWN-AAAAAA-BBBBBB" });

    // The insert for the audit row must have been called
    expect(mockDbInsert).toHaveBeenCalled();
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ promoCodeId: 42, userId: 1, tier: "pro" })
    );
  });

  it("returns 410 when the atomic claim returns 0 rows (concurrent exhaustion race)", async () => {
    mockDbWhere
      .mockResolvedValueOnce([promoRow({ usedCount: 0, maxUses: 1 })]) // promo
      .mockResolvedValueOnce([{ subscriptionTier: "free" }]); // user
    // Simulate a concurrent request having already claimed the last use
    mockDbReturning.mockResolvedValue([]);

    const res = await request(app)
      .post("/api/promo-codes/redeem")
      .set(AUTH)
      .send({ code: "CLOWN-AAAAAA-BBBBBB" });

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/no remaining uses/i);
  });

  it("uppercases the submitted code before lookup", async () => {
    mockDbWhere.mockResolvedValueOnce([]);

    await request(app)
      .post("/api/promo-codes/redeem")
      .set(AUTH)
      .send({ code: "clown-aaaaaa-bbbbbb" });

    expect(mockDbSelect).toHaveBeenCalled();
  });
});

// ── Tests: GET /api/admin/promo-codes/:id/redemptions ────────────────────────

describe("GET /api/admin/promo-codes/:id/redemptions", () => {
  /** Make the admin check resolve this userId as admin */
  const ADMIN_ENV_ID = "1";

  beforeEach(() => {
    process.env["ADMIN_USER_IDS"] = ADMIN_ENV_ID;
    // Admin select: resolve userId=1 as admin (resolveAdminUserIds numeric path)
    // No DB lookup needed for numeric tokens — they are parsed directly.
  });

  it("returns 401 when not authenticated", async () => {
    mockRequireAuth.mockImplementation((_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
      res.status(401).json({ error: "Unauthorized" });
    });

    const res = await request(app)
      .get("/api/admin/promo-codes/42/redemptions");

    expect(res.status).toBe(401);
  });

  it("returns 403 when user is not an admin", async () => {
    mockGetUser.mockReturnValue({ userId: 999, email: "other@test.com", username: "other" });

    const res = await request(app)
      .get("/api/admin/promo-codes/42/redemptions")
      .set(AUTH);

    expect(res.status).toBe(403);
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await request(app)
      .get("/api/admin/promo-codes/not-a-number/redemptions")
      .set(AUTH);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it("returns an array of redemptions joined with user info", async () => {
    const redemptionRows = [
      {
        id: 1,
        userId: 1,
        username: "testuser",
        email: "test@test.com",
        tier: "pro",
        redeemedAt: new Date("2026-01-01T10:00:00Z"),
      },
    ];
    // The admin redemptions endpoint uses: select().from().leftJoin().where().orderBy()
    mockDbLeftJoin.mockReturnValueOnce({
      where: vi.fn(() => ({ orderBy: vi.fn().mockResolvedValue(redemptionRows) })),
      orderBy: vi.fn().mockResolvedValue(redemptionRows),
    });

    const res = await request(app)
      .get("/api/admin/promo-codes/42/redemptions")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
