/**
 * Unit tests for syncSubscriptions().
 *
 * All external I/O is mocked:
 *   - `@workspace/db`  → vi.mock so the DB is never touched
 *   - `fetch`          → vi.stubGlobal to simulate RevenueCat responses
 *   - `process.env`    → set/delete per test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock state ───────────────────────────────────────────────────────
// vi.hoisted() runs before the module graph is resolved, so these are safe to
// reference inside vi.mock() factory functions.

const { mockUpdate, mockSet, mockSetWhere, mockSelect, mockFrom, mockWhere } =
  vi.hoisted(() => {
    const mockSetWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn(() => ({ where: mockSetWhere }));
    const mockUpdate = vi.fn(() => ({ set: mockSet }));

    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockFrom = vi.fn(() => ({ where: mockWhere }));
    const mockSelect = vi.fn(() => ({ from: mockFrom }));

    return { mockUpdate, mockSet, mockSetWhere, mockSelect, mockFrom, mockWhere };
  });

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
  },
  usersTable: {
    id: "id",
    subscriptionTier: "subscriptionTier",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ col: _col, val })),
}));

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { syncSubscriptions } from "../subscriptionSync";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal RevenueCat subscriber response. */
function rcResponse(
  entitlementId: string,
  expiresDate: string | null,
): Record<string, unknown> {
  return {
    subscriber: {
      entitlements: {
        [entitlementId]: {
          expires_date: expiresDate,
          product_identifier: "pro_monthly",
        },
      },
    },
  };
}

/** Stub global fetch to return a single canned response. */
function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  );
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.REVENUECAT_API_KEY = "test-api-key";
  delete process.env.REVENUECAT_PRO_ENTITLEMENT_ID;

  mockSelect.mockClear();
  mockFrom.mockClear();
  mockWhere.mockClear();
  mockUpdate.mockClear();
  mockSet.mockClear();
  mockSetWhere.mockClear();

  // Default: no pro users
  mockWhere.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.REVENUECAT_API_KEY;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("syncSubscriptions — missing API key", () => {
  it("returns early without touching the DB or calling RevenueCat", async () => {
    delete process.env.REVENUECAT_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await syncSubscriptions();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe("syncSubscriptions — RC API 404 (user not found in RevenueCat)", () => {
  it("reverts the user to free when RC returns 404", async () => {
    mockWhere.mockResolvedValueOnce([{ id: 42 }]);
    stubFetch(404, {});

    await syncSubscriptions();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith({ subscriptionTier: "free" });
  });
});

describe("syncSubscriptions — active entitlement (no revert)", () => {
  it("does not revert a user with a valid non-expired entitlement", async () => {
    mockWhere.mockResolvedValueOnce([{ id: 7 }]);

    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    stubFetch(200, rcResponse("pro", future));

    await syncSubscriptions();

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("does not revert a user with a lifetime (null expires_date) entitlement", async () => {
    mockWhere.mockResolvedValueOnce([{ id: 8 }]);
    stubFetch(200, rcResponse("pro", null));

    await syncSubscriptions();

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe("syncSubscriptions — expired entitlement", () => {
  it("reverts a user whose entitlement has already expired", async () => {
    mockWhere.mockResolvedValueOnce([{ id: 99 }]);

    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    stubFetch(200, rcResponse("pro", past));

    await syncSubscriptions();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith({ subscriptionTier: "free" });
  });
});

describe("syncSubscriptions — RC API 500 (server error)", () => {
  it("skips the user and does NOT revert when RevenueCat returns 500", async () => {
    mockWhere.mockResolvedValueOnce([{ id: 55 }]);
    stubFetch(500, { message: "internal server error" });

    await expect(syncSubscriptions()).resolves.toBeUndefined();

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("continues checking remaining users after a 500 for one user", async () => {
    mockWhere.mockResolvedValueOnce([{ id: 55 }, { id: 56 }]);

    // First call → 500 (skip), second call → 404 (revert)
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 500,
          ok: false,
          text: async () => "internal server error",
        })
        .mockResolvedValueOnce({
          status: 404,
          ok: false,
          text: async () => "not found",
        }),
    );

    await syncSubscriptions();

    // Only user 56 (the 404) should have been reverted
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // The where clause should reference user 56
    const whereArg = mockSetWhere.mock.calls[0][0] as { val: number };
    expect(whereArg.val).toBe(56);
  });
});

describe("syncSubscriptions — custom entitlement ID", () => {
  it("uses REVENUECAT_PRO_ENTITLEMENT_ID env var when set", async () => {
    process.env.REVENUECAT_PRO_ENTITLEMENT_ID = "premium";
    mockWhere.mockResolvedValueOnce([{ id: 1 }]);

    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    stubFetch(200, rcResponse("premium", future));

    await syncSubscriptions();

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("reverts user when the custom entitlement is absent from RC response", async () => {
    process.env.REVENUECAT_PRO_ENTITLEMENT_ID = "premium";
    mockWhere.mockResolvedValueOnce([{ id: 2 }]);

    // RC returns "pro" but we're looking for "premium"
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    stubFetch(200, rcResponse("pro", future));

    await syncSubscriptions();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith({ subscriptionTier: "free" });
  });
});

describe("syncSubscriptions — no pro users in DB", () => {
  it("makes no RC calls and no DB updates when there are no pro users", async () => {
    mockWhere.mockResolvedValueOnce([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await syncSubscriptions();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
