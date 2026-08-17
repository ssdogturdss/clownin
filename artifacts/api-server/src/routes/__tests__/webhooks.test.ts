/**
 * Tests for the RevenueCat webhook endpoint.
 *
 * Covers the security guard (Authorization header verification) and the
 * subscription-tier update logic so a regression cannot silently let anyone
 * grant themselves Pro access.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// ── Mock @workspace/db before any app code is imported ──────────────────────
// The real module throws at import time when DATABASE_URL is unset, and makes
// live DB calls. We replace it with controllable stubs.

const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockWhere = vi.fn().mockResolvedValue(undefined);

mockSet.mockReturnValue({ where: mockWhere });
mockUpdate.mockReturnValue({ set: mockSet });

vi.mock("@workspace/db", () => ({
  db: { update: mockUpdate },
  usersTable: {},
}));

// drizzle-orm's `eq` is a pure helper — a lightweight stub is fine
vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

// Import the app *after* the mocks are in place so that the mocked modules
// are resolved when webhooks.ts is first evaluated.
const { default: app } = await import("../../app.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

const SECRET = "test-webhook-secret";

function rcPayload(eventType: string, appUserId: string | undefined) {
  return {
    event: {
      type: eventType,
      ...(appUserId !== undefined ? { app_user_id: appUserId } : {}),
    },
  };
}

function post(payload: object, authHeader?: string) {
  const req = request(app)
    .post("/webhooks/revenuecat")
    .set("Content-Type", "application/json");
  if (authHeader !== undefined) {
    req.set("Authorization", authHeader);
  }
  return req.send(JSON.stringify(payload));
}

// ── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  vi.clearAllMocks();
  // Re-wire the mock chain after clearAllMocks
  mockWhere.mockResolvedValue(undefined);
  mockSet.mockReturnValue({ where: mockWhere });
  mockUpdate.mockReturnValue({ set: mockSet });
});

afterEach(() => {
  delete process.env.REVENUECAT_WEBHOOK_SECRET;
});

// ── Security guard ───────────────────────────────────────────────────────────

describe("RevenueCat webhook — authorization guard", () => {
  it("returns 401 when Authorization header is missing and does not write to DB", async () => {
    const res = await post(rcPayload("INITIAL_PURCHASE", "42"));
    expect(res.status).toBe(401);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header has the wrong secret and does not write to DB", async () => {
    const res = await post(rcPayload("INITIAL_PURCHASE", "42"), "wrong-secret");
    expect(res.status).toBe(401);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("accepts a request with the correct secret", async () => {
    const res = await post(rcPayload("INITIAL_PURCHASE", "42"), SECRET);
    expect(res.status).toBe(200);
  });
});

// ── Subscription upgrades ─────────────────────────────────────────────────────

describe("RevenueCat webhook — INITIAL_PURCHASE upgrades user to pro", () => {
  it("sets subscriptionTier to 'pro' for the correct user", async () => {
    const res = await post(rcPayload("INITIAL_PURCHASE", "99"), SECRET);
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockSet).toHaveBeenCalledWith({ subscriptionTier: "pro" });
    // The where clause should reference user id 99
    expect(mockWhere).toHaveBeenCalledWith(
      expect.objectContaining({ val: 99 }),
    );
  });
});

// ── Subscription cancellations ────────────────────────────────────────────────

describe("RevenueCat webhook — CANCELLATION reverts user to free", () => {
  it("sets subscriptionTier to 'free' for the correct user", async () => {
    const res = await post(rcPayload("CANCELLATION", "99"), SECRET);
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockSet).toHaveBeenCalledWith({ subscriptionTier: "free" });
    expect(mockWhere).toHaveBeenCalledWith(
      expect.objectContaining({ val: 99 }),
    );
  });
});

// ── Unknown event type ────────────────────────────────────────────────────────

describe("RevenueCat webhook — unknown event type", () => {
  it("returns 200 and does not write to DB for an unrecognised event", async () => {
    const res = await post(rcPayload("TEST_EVENT", "42"), SECRET);
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ── Anonymous / non-numeric app_user_id ──────────────────────────────────────

describe("RevenueCat webhook — non-numeric app_user_id", () => {
  it("returns 200 and does not write to DB for an anonymous RC user ID", async () => {
    const res = await post(
      rcPayload("INITIAL_PURCHASE", "$RCAnonymousID:abc123"),
      SECRET,
    );
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
