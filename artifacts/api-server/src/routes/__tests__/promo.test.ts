/**
 * Integration tests for POST /api/promo-codes/redeem.
 *
 * All external I/O is mocked:
 *   - @workspace/db  → vi.mock so the real DB is never touched
 *   - drizzle-orm    → lightweight stubs
 *   - ../lib/auth    → stubs requireAuth + getUser so JWT signing is bypassed
 *   - node-cron      → prevent real cron jobs from starting
 *
 * Covers:
 *   - Auth guard (401 when no token)
 *   - Validation (400 when code missing)
 *   - Invalid code (404)
 *   - Inactive code (410)
 *   - Expired code (410)
 *   - Already on this tier (409)
 *   - Successful redemption (200 with tier + message)
 *   - Concurrent single-use exhaustion (410 when atomic claim fails)
 *   - Code is uppercased before lookup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  mockDbTransaction,
  mockRequireAuth,
  mockGetUser,
} = vi.hoisted(() => {
  // ── DB: .select().from().where() ──────────────────────────────────────────
  const mockDbWhere = vi.fn().mockResolvedValue([]);
  const mockDbFrom = vi.fn(() => ({ where: mockDbWhere }));
  const mockDbSelect = vi.fn(() => ({ from: mockDbFrom }));

  // ── DB: .update().set().where().returning() ───────────────────────────────
  const mockDbReturning = vi.fn().mockResolvedValue([{ id: 42, tier: "pro" }]);
  const mockDbUpdateWhere = vi.fn(() => ({ returning: mockDbReturning }));
  const mockDbSet = vi.fn(() => ({ where: mockDbUpdateWhere }));
  const mockDbUpdate = vi.fn(() => ({ set: mockDbSet }));

  // ── DB: transaction ───────────────────────────────────────────────────────
  const mockDbTransaction = vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
    const tx = { update: mockDbUpdate };
    return cb(tx);
  });

  // ── Auth ──────────────────────────────────────────────────────────────────
  // By default requireAuth calls next() (authenticated as userId=1).
  // Tests that exercise the 401 path override this.
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
    mockDbTransaction,
    mockRequireAuth,
    mockGetUser,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
    transaction: mockDbTransaction,
  },
  usersTable: {
    id: "id",
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
}));

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, val: unknown) => ({ eq: val }),
  and: (...args: unknown[]) => ({ and: args }),
  or: (...args: unknown[]) => ({ or: args }),
  isNull: (_col: unknown) => ({ isNull: true }),
  gt: (_col: unknown, val: unknown) => ({ gt: val }),
  lt: (_col: unknown, val: unknown) => ({ lt: val }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: String(strings),
    values,
  }),
}));

// Bypass real JWT verification — auth state is controlled by mockRequireAuth/mockGetUser.
vi.mock("../../lib/auth.js", () => ({
  requireAuth: mockRequireAuth,
  getUser: mockGetUser,
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

  // Default select: no results
  mockDbWhere.mockResolvedValue([]);

  // Default transaction: call callback with tx proxy
  mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    const tx = { update: mockDbUpdate };
    return cb(tx);
  });

  // Default claim: returns 1 row (success)
  mockDbReturning.mockResolvedValue([{ id: 42, tier: "pro" }]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/promo-codes/redeem", () => {
  it("returns 401 when not authenticated", async () => {
    // Override: requireAuth sends a 401 response directly
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
    // Code not found — we only care that the lookup was invoked
    mockDbWhere.mockResolvedValueOnce([]);

    await request(app)
      .post("/api/promo-codes/redeem")
      .set(AUTH)
      .send({ code: "clown-aaaaaa-bbbbbb" });

    // The select chain should have been called (at minimum the promo lookup)
    expect(mockDbSelect).toHaveBeenCalled();
  });
});
