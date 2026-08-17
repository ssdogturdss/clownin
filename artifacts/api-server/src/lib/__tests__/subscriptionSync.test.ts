/**
 * Unit tests for syncSubscriptions().
 *
 * All external I/O is mocked:
 *   - `@workspace/db`  → vi.mock so the DB is never touched
 *   - `fetch`          → vi.stubGlobal to simulate RevenueCat responses
 *   - `process.env`    → set/delete per test
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

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

import { syncSubscriptions, sendSyncErrorAlert } from "../subscriptionSync";
import { logger } from "../logger";

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
  // Disable error retries by default so existing tests stay fast (no sleep)
  process.env.REVENUECAT_SYNC_ERROR_RETRIES = "0";

  mockSelect.mockClear();
  mockFrom.mockClear();
  mockWhere.mockClear();
  mockUpdate.mockClear();
  mockSet.mockClear();
  mockSetWhere.mockClear();

  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.info).mockClear();

  // Default: no pro users
  mockWhere.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.REVENUECAT_API_KEY;
  delete process.env.REVENUECAT_SYNC_ERROR_RETRIES;
  delete process.env.SYNC_ALERT_WEBHOOK_URL;
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

// ─── Warning on non-zero error count ─────────────────────────────────────────

describe("syncSubscriptions — structured warning on errors", () => {
  it("emits a warn log with syncErrors field when RC returns 500", async () => {
    mockWhere.mockResolvedValueOnce([{ id: 55 }]);
    stubFetch(500, { message: "internal server error" });

    await syncSubscriptions();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ syncErrors: 1 }),
      expect.stringContaining("RevenueCat may be degraded"),
    );
  });

  it("does NOT emit a warn log when all users complete without errors", async () => {
    mockWhere.mockResolvedValueOnce([{ id: 7 }]);
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    stubFetch(200, rcResponse("pro", future));

    await syncSubscriptions();

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const degradedWarning = warnCalls.find(([, msg]) =>
      typeof msg === "string" && msg.includes("RevenueCat may be degraded"),
    );
    expect(degradedWarning).toBeUndefined();
  });

  it("includes the correct error count in the syncErrors field", async () => {
    // Two users, both returning 500
    mockWhere.mockResolvedValueOnce([{ id: 10 }, { id: 11 }]);
    stubFetch(500, { message: "server error" });

    await syncSubscriptions();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ syncErrors: 2 }),
      expect.stringContaining("RevenueCat may be degraded"),
    );
  });
});

// ─── Retry loop for transient RC failures ────────────────────────────────────

describe("syncSubscriptions — retry on transient 5xx errors", () => {
  beforeEach(() => {
    // Enable 2 error retries for retry-specific tests; use fake timers to avoid
    // real sleep delays.
    process.env.REVENUECAT_SYNC_ERROR_RETRIES = "2";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds on the second attempt after a transient 500", async () => {
    mockWhere.mockResolvedValueOnce([{ id: 20 }]);

    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 500,
          ok: false,
          text: async () => "server error",
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => rcResponse("pro", future),
          text: async () => "",
        }),
    );

    const syncPromise = syncSubscriptions();
    // Advance fake timers to skip the backoff sleep
    await vi.runAllTimersAsync();
    await syncPromise;

    // No errors — user had a valid entitlement on the second attempt
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(
      expect.objectContaining({ syncErrors: expect.anything() }),
      expect.any(String),
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("counts as an error only after all retries are exhausted", async () => {
    mockWhere.mockResolvedValueOnce([{ id: 21 }]);

    // Always returns 500 — exhausts all 3 attempts (initial + 2 retries)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 500,
        ok: false,
        text: async () => "server error",
      }),
    );

    const syncPromise = syncSubscriptions();
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ syncErrors: 1 }),
      expect.stringContaining("RevenueCat may be degraded"),
    );
    // Three fetch calls: initial + 2 retries
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(3);
  });

  it("logs a transient-retry warning on each failed attempt before giving up", async () => {
    mockWhere.mockResolvedValueOnce([{ id: 22 }]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 500,
        ok: false,
        text: async () => "server error",
      }),
    );

    const syncPromise = syncSubscriptions();
    await vi.runAllTimersAsync();
    await syncPromise;

    const retryCalls = vi.mocked(logger.warn).mock.calls.filter(([, msg]) =>
      typeof msg === "string" && msg.includes("transient error checking user"),
    );
    // 2 retry warnings (attempt 0 and attempt 1 before giving up on attempt 2)
    expect(retryCalls).toHaveLength(2);
  });
});

// ─── sendSyncErrorAlert unit tests ───────────────────────────────────────────

describe("sendSyncErrorAlert", () => {
  it("POSTs to the webhook URL with error count and timestamp", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await sendSyncErrorAlert(3, 10, "2026-08-17T03:00:00.000Z", "https://hooks.example.com/test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/test");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });

    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toContain("3");
    expect(body.text).toContain("10");
    expect(body.text).toContain("2026-08-17T03:00:00.000Z");
  });

  it("logs a warning instead of throwing when the webhook returns non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    });
    vi.stubGlobal("fetch", fetchMock);

    // Should not throw
    await expect(
      sendSyncErrorAlert(1, 5, "2026-08-17T03:00:00.000Z", "https://hooks.example.com/test"),
    ).resolves.toBeUndefined();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500 }),
      expect.stringContaining("non-2xx"),
    );
  });

  it("logs a warning and does not throw when fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network failure")));

    await expect(
      sendSyncErrorAlert(2, 8, "2026-08-17T03:00:00.000Z", "https://hooks.example.com/test"),
    ).resolves.toBeUndefined();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("failed to send alert webhook"),
    );
  });
});

// ─── Webhook alert integration inside syncSubscriptions ──────────────────────

describe("syncSubscriptions — webhook alert on errors", () => {
  it("POSTs to SYNC_ALERT_WEBHOOK_URL when errors > 0", async () => {
    process.env.SYNC_ALERT_WEBHOOK_URL = "https://hooks.example.com/oncall";
    mockWhere.mockResolvedValueOnce([{ id: 55 }]);
    stubFetch(500, { message: "server error" });

    // Second fetch call goes to the webhook — capture both
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 500,
        ok: false,
        text: async () => "server error",
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await syncSubscriptions();

    // The second fetch should be the webhook POST
    const webhookCall = fetchMock.mock.calls.find(
      ([url]) => url === "https://hooks.example.com/oncall",
    );
    expect(webhookCall).toBeDefined();
    const body = JSON.parse(webhookCall![1].body as string) as { text: string };
    expect(body.text).toContain("1"); // 1 error
  });

  it("does NOT POST to the webhook when there are no errors", async () => {
    process.env.SYNC_ALERT_WEBHOOK_URL = "https://hooks.example.com/oncall";
    mockWhere.mockResolvedValueOnce([{ id: 7 }]);

    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => rcResponse("pro", future),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    await syncSubscriptions();

    const webhookCall = fetchMock.mock.calls.find(
      ([url]) => url === "https://hooks.example.com/oncall",
    );
    expect(webhookCall).toBeUndefined();
  });

  it("logs a warning when SYNC_ALERT_WEBHOOK_URL is not set and errors > 0", async () => {
    delete process.env.SYNC_ALERT_WEBHOOK_URL;
    mockWhere.mockResolvedValueOnce([{ id: 55 }]);
    stubFetch(500, { message: "server error" });

    await syncSubscriptions();

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const missingWebhookWarn = warnCalls.find(([msg]) =>
      typeof msg === "string" && msg.includes("SYNC_ALERT_WEBHOOK_URL not set"),
    );
    expect(missingWebhookWarn).toBeDefined();
  });
});
