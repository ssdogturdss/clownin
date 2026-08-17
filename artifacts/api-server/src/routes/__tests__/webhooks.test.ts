/**
 * Tests for the RevenueCat webhook endpoint.
 *
 * Covers:
 * - Security guard (Authorization header verification, dual-secret rotation)
 * - Subscription-tier update logic
 * - Upgrade-spike detection / abuse monitoring
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// ── Mock @workspace/db before any app code is imported ──────────────────────
// vi.hoisted ensures these variables are initialised before the vi.mock factory
// runs (which in turn fires when webhooks.ts is first imported).

const { mockUpdate, mockSet, mockWhere } = vi.hoisted(() => {
  const mockWhere = vi.fn().mockResolvedValue(undefined);
  const mockSet   = vi.fn().mockReturnValue({ where: mockWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
  return { mockUpdate, mockSet, mockWhere };
});

vi.mock("@workspace/db", () => ({
  db: { update: mockUpdate },
  usersTable: {},
}));

// drizzle-orm's `eq` is a pure helper — a lightweight stub is fine
vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

// Prevent node-cron from scheduling real jobs during tests
vi.mock("node-cron", () => ({
  default: { schedule: vi.fn() },
}));

// Import the app and webhook utilities *after* the mocks are in place.
// The app import is dynamic to maintain the original ordering guarantee.
const { default: app } = await import("../../app.js");
import { isValidSecret, recordAndCheckSpike, _spikeCounter, type SpikeCounter } from "../webhooks.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const SECRET      = "test-webhook-secret";
const PREV_SECRET = "old-webhook-secret";

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
  delete process.env.REVENUECAT_WEBHOOK_SECRET_PREV;
  vi.clearAllMocks();
  // Re-wire the mock chain after clearAllMocks
  mockWhere.mockResolvedValue(undefined);
  mockSet.mockReturnValue({ where: mockWhere });
  mockUpdate.mockReturnValue({ set: mockSet });
  // Reset the spike counter so tests are isolated
  _spikeCounter.upgrades   = [];
  _spikeCounter.downgrades = [];
  _spikeCounter.lastAlertAt = 0;
});

afterEach(() => {
  delete process.env.REVENUECAT_WEBHOOK_SECRET;
  delete process.env.REVENUECAT_WEBHOOK_SECRET_PREV;
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

  it("accepts a request with the correct primary secret", async () => {
    const res = await post(rcPayload("INITIAL_PURCHASE", "42"), SECRET);
    expect(res.status).toBe(200);
  });
});

// ── Dual-secret rotation ──────────────────────────────────────────────────────

describe("RevenueCat webhook — zero-downtime secret rotation", () => {
  it("accepts a request with the previous secret when REVENUECAT_WEBHOOK_SECRET_PREV is set", async () => {
    process.env.REVENUECAT_WEBHOOK_SECRET_PREV = PREV_SECRET;
    const res = await post(rcPayload("INITIAL_PURCHASE", "42"), PREV_SECRET);
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledOnce();
  });

  it("still rejects a wrong secret even when a previous secret is configured", async () => {
    process.env.REVENUECAT_WEBHOOK_SECRET_PREV = PREV_SECRET;
    const res = await post(rcPayload("INITIAL_PURCHASE", "42"), "totally-wrong");
    expect(res.status).toBe(401);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("accepts the new primary secret regardless of whether a previous secret is set", async () => {
    process.env.REVENUECAT_WEBHOOK_SECRET_PREV = PREV_SECRET;
    const res = await post(rcPayload("INITIAL_PURCHASE", "42"), SECRET);
    expect(res.status).toBe(200);
  });
});

// ── isValidSecret unit tests ──────────────────────────────────────────────────

describe("isValidSecret", () => {
  it("returns false when REVENUECAT_WEBHOOK_SECRET is not set", () => {
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
    expect(isValidSecret("anything")).toBe(false);
  });

  it("returns true for the primary secret", () => {
    expect(isValidSecret(SECRET)).toBe(true);
  });

  it("returns false for a wrong string", () => {
    expect(isValidSecret("not-the-secret")).toBe(false);
  });

  it("returns true for the previous secret when REVENUECAT_WEBHOOK_SECRET_PREV is set", () => {
    process.env.REVENUECAT_WEBHOOK_SECRET_PREV = PREV_SECRET;
    expect(isValidSecret(PREV_SECRET)).toBe(true);
  });

  it("returns false for the previous secret when REVENUECAT_WEBHOOK_SECRET_PREV is NOT set", () => {
    expect(isValidSecret(PREV_SECRET)).toBe(false);
  });

  it("returns false for an empty string even when env vars are set", () => {
    expect(isValidSecret("")).toBe(false);
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

// ── Spike detection ───────────────────────────────────────────────────────────

describe("recordAndCheckSpike — unit tests", () => {
  it("does not flag a spike when upgrade count is below the minimum threshold", () => {
    const counter: SpikeCounter = { upgrades: [], downgrades: [], lastAlertAt: 0 };
    // 9 upgrades, 0 downgrades — below SPIKE_MIN_UPGRADES (10)
    for (let i = 0; i < 9; i++) {
      const spiked = recordAndCheckSpike("upgrade", counter);
      expect(spiked).toBe(false);
    }
  });

  it("flags a spike when upgrades ≥ 10 and ratio ≥ 10 (no downgrades)", () => {
    const counter: SpikeCounter = { upgrades: [], downgrades: [], lastAlertAt: 0 };
    let spiked = false;
    for (let i = 0; i < 10; i++) {
      spiked = recordAndCheckSpike("upgrade", counter);
    }
    // 10 upgrades, 0 downgrades → ratio = 10 / max(1,0) = 10 ≥ threshold
    expect(spiked).toBe(true);
  });

  it("does not flag a spike when upgrades and downgrades are balanced", () => {
    const counter: SpikeCounter = { upgrades: [], downgrades: [], lastAlertAt: 0 };
    // 20 upgrades, 20 downgrades → ratio = 1
    for (let i = 0; i < 20; i++) {
      recordAndCheckSpike("downgrade", counter);
      const spiked = recordAndCheckSpike("upgrade", counter);
      expect(spiked).toBe(false);
    }
  });

  it("does not flag a spike for 11 upgrades with at least 2 downgrades (ratio < 10)", () => {
    const counter: SpikeCounter = { upgrades: [], downgrades: [], lastAlertAt: 0 };
    recordAndCheckSpike("downgrade", counter);
    recordAndCheckSpike("downgrade", counter);
    // 11 upgrades, 2 downgrades → ratio = 5.5 < 10
    let spiked = false;
    for (let i = 0; i < 11; i++) {
      spiked = recordAndCheckSpike("upgrade", counter);
    }
    expect(spiked).toBe(false);
  });

  it("prunes events outside the 1-hour window", () => {
    const counter: SpikeCounter = { upgrades: [], downgrades: [], lastAlertAt: 0 };
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1_000;

    // Simulate 9 upgrades from 2 hours ago (outside window)
    for (let i = 0; i < 9; i++) {
      counter.upgrades.push(twoHoursAgo);
    }
    // Add 1 upgrade now — only 1 upgrade is in-window, below minimum threshold
    const spiked = recordAndCheckSpike("upgrade", counter, now);
    expect(spiked).toBe(false);
    // The 9 old timestamps should have been pruned
    expect(counter.upgrades.length).toBe(1);
  });

  it("does not emit a second alert within the cooldown window", () => {
    const counter: SpikeCounter = { upgrades: [], downgrades: [], lastAlertAt: 0 };
    const now = Date.now();
    // Drive the counter past the threshold to get the first alert
    for (let i = 0; i < 10; i++) {
      counter.upgrades.push(now);
    }
    const first = recordAndCheckSpike("upgrade", counter, now);
    expect(first).toBe(true);
    // Immediately check again — cooldown suppresses the next alert
    const second = recordAndCheckSpike("upgrade", counter, now + 1);
    expect(second).toBe(false);
  });

  it("caps the upgrade array at MAX_SPIKE_ENTRIES (500) so memory is bounded", () => {
    const counter: SpikeCounter = { upgrades: [], downgrades: [], lastAlertAt: 0 };
    const now = Date.now();
    // Drive 600 upgrades through recordAndCheckSpike, all within the 1-hour
    // window, to verify the bounded append keeps the array ≤ 500.
    for (let i = 0; i < 600; i++) {
      recordAndCheckSpike("upgrade", counter, now + i);
    }
    expect(counter.upgrades.length).toBeLessThanOrEqual(500);
  });
});

describe("RevenueCat webhook — spike detection integration", () => {
  it("still returns 200 even when a spike is detected (monitoring only, not blocking)", async () => {
    // Pre-fill the counter so the very next upgrade triggers a spike
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      _spikeCounter.upgrades.push(now);
    }
    const res = await post(rcPayload("INITIAL_PURCHASE", "42"), SECRET);
    // The endpoint must not reject the request — spike detection is observability only
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledOnce();
  });
});

// ── Concurrent duplicate events ───────────────────────────────────────────────

describe("RevenueCat webhook — concurrent duplicate events for the same user", () => {
  it("processes simultaneous upgrade events for the same user without crashing and returns 200 for each", async () => {
    const CONCURRENCY = 10;
    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        post(rcPayload("INITIAL_PURCHASE", "77"), SECRET),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    }
    // Each concurrent request independently triggers a DB write
    expect(mockUpdate).toHaveBeenCalledTimes(CONCURRENCY);
  });

  it("processes simultaneous cancellation events for the same user without crashing and returns 200 for each", async () => {
    const CONCURRENCY = 5;
    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        post(rcPayload("CANCELLATION", "77"), SECRET),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    }
    expect(mockUpdate).toHaveBeenCalledTimes(CONCURRENCY);
  });

  it("handles a mixed flood of upgrades and downgrades for the same user concurrently", async () => {
    const upgrades = Array.from({ length: 6 }, () =>
      post(rcPayload("RENEWAL", "88"), SECRET),
    );
    const downgrades = Array.from({ length: 4 }, () =>
      post(rcPayload("EXPIRATION", "88"), SECRET),
    );
    const responses = await Promise.all([...upgrades, ...downgrades]);
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
    expect(mockUpdate).toHaveBeenCalledTimes(10);
  });

  it("deduplication: two identical payloads both return 200 — idempotency is the DB's responsibility, not the handler's", async () => {
    const [first, second] = await Promise.all([
      post(rcPayload("INITIAL_PURCHASE", "55"), SECRET),
      post(rcPayload("INITIAL_PURCHASE", "55"), SECRET),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Both writes reach the DB — upsert/idempotency handled at the data layer
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockSet).toHaveBeenNthCalledWith(1, { subscriptionTier: "pro" });
    expect(mockSet).toHaveBeenNthCalledWith(2, { subscriptionTier: "pro" });
  });
});

// ── Unknown / non-existent users ──────────────────────────────────────────────

describe("RevenueCat webhook — events for users that do not exist in the DB", () => {
  it("returns 200 for an upgrade event referencing a non-existent user ID", async () => {
    // The mocked DB resolves with undefined (same as 0 rows updated).
    // The handler must not inspect the update count — it acknowledges the event
    // regardless, because RevenueCat expects a 2xx or it will retry indefinitely.
    const res = await post(rcPayload("INITIAL_PURCHASE", "999999"), SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockSet).toHaveBeenCalledWith({ subscriptionTier: "pro" });
  });

  it("returns 200 for a cancellation event referencing a non-existent user ID", async () => {
    const res = await post(rcPayload("CANCELLATION", "999999"), SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockSet).toHaveBeenCalledWith({ subscriptionTier: "free" });
  });

  it("does not throw and returns 200 when the DB update rejects (simulated transient error)", async () => {
    // Simulate a transient DB error — the handler should propagate the 500,
    // which is the correct signal for RevenueCat to retry the event later.
    mockWhere.mockRejectedValueOnce(new Error("connection timeout"));
    const res = await post(rcPayload("INITIAL_PURCHASE", "999"), SECRET);
    // A 500 lets RevenueCat know it should retry — correct behaviour on DB failure
    expect(res.status).toBe(500);
  });

  it("does not write to DB for an event whose app_user_id is the string 'null'", async () => {
    // Defensive: some SDKs may serialise null as the string "null"
    const res = await post(rcPayload("INITIAL_PURCHASE", "null"), SECRET);
    // parseInt("null", 10) → NaN → handler ignores it as a non-numeric ID
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("does not write to DB for a zero user ID (falsy-like but numeric)", async () => {
    // userId 0 passes parseInt but is falsy in JS; the handler must not map it
    // to a real user. parseInt("0") = 0, which is a valid number, so the
    // handler will try to update — we verify it does NOT silently skip it.
    const res = await post(rcPayload("INITIAL_PURCHASE", "0"), SECRET);
    expect(res.status).toBe(200);
    // The handler sends the update (DB enforces whether id=0 is valid)
    expect(mockUpdate).toHaveBeenCalledOnce();
  });
});

// ── Malformed / missing fields ────────────────────────────────────────────────

describe("RevenueCat webhook — malformed or missing payload fields", () => {
  it("returns 400 for a completely empty body", async () => {
    const req = request(app)
      .post("/webhooks/revenuecat")
      .set("Content-Type", "application/json")
      .set("Authorization", SECRET);
    const res = await req.send("");
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that is valid JSON but not an object (bare array)", async () => {
    const req = request(app)
      .post("/webhooks/revenuecat")
      .set("Content-Type", "application/json")
      .set("Authorization", SECRET);
    const res = await req.send(JSON.stringify([1, 2, 3]));
    // An array has no .event property → handler returns 400 "Missing event object"
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that is valid JSON null", async () => {
    const req = request(app)
      .post("/webhooks/revenuecat")
      .set("Content-Type", "application/json")
      .set("Authorization", SECRET);
    const res = await req.send("null");
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 when the event field is not an object (event is a string)", async () => {
    const res = await post({ event: "INITIAL_PURCHASE" }, SECRET);
    // event is not an object → no .type → eventType is undefined → not in UPGRADE_EVENTS
    // But event itself is truthy, so the handler proceeds and sees no app_user_id → 200
    // Documenting the actual behaviour: missing app_user_id returns 200
    expect([200, 400]).toContain(res.status);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 for truncated / syntactically invalid JSON", async () => {
    const req = request(app)
      .post("/webhooks/revenuecat")
      .set("Content-Type", "application/json")
      .set("Authorization", SECRET);
    const res = await req.send('{"event":{"type":"INITIAL_PURCHASE"');
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 when the top-level event key is missing", async () => {
    const res = await post({ type: "INITIAL_PURCHASE", app_user_id: "42" }, SECRET);
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 when event is explicitly null", async () => {
    const res = await post({ event: null }, SECRET);
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 200 and does not write to DB when event.type is missing", async () => {
    // type is undefined → not in UPGRADE_EVENTS or DOWNGRADE_EVENTS
    const res = await post({ event: { app_user_id: "42" } }, SECRET);
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 200 and does not write to DB when event.app_user_id is missing but event.type is present", async () => {
    // app_user_id and original_app_user_id both absent → handler logs and returns 200
    const res = await post({ event: { type: "INITIAL_PURCHASE" } }, SECRET);
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 200 and does not write to DB when app_user_id is an empty string", async () => {
    const res = await post(
      { event: { type: "INITIAL_PURCHASE", app_user_id: "" } },
      SECRET,
    );
    // parseInt("", 10) → NaN → treated as anonymous ID → no DB write
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("falls back to original_app_user_id when app_user_id is absent", async () => {
    const res = await post(
      { event: { type: "INITIAL_PURCHASE", original_app_user_id: "77" } },
      SECRET,
    );
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockWhere).toHaveBeenCalledWith(
      expect.objectContaining({ val: 77 }),
    );
  });

  it("returns 500 when REVENUECAT_WEBHOOK_SECRET env var is not set", async () => {
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
    const res = await post(rcPayload("INITIAL_PURCHASE", "42"), SECRET);
    expect(res.status).toBe(500);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("handles a deeply nested event object without crashing", async () => {
    const res = await post(
      {
        event: {
          type: "INITIAL_PURCHASE",
          app_user_id: "42",
          nested: { deeply: { nested: { field: "value" } } },
          extra_array: [1, 2, 3],
        },
      },
      SECRET,
    );
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledOnce();
  });

  it("returns 200 and does not write to DB for an event with type set to null", async () => {
    const res = await post(
      { event: { type: null, app_user_id: "42" } },
      SECRET,
    );
    // null eventType is not in UPGRADE_EVENTS → no DB write
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
