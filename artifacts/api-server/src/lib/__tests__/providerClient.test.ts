/**
 * Unit tests for getProviderClient().
 *
 * Covers three critical cache-bypass scenarios:
 *   (a) A decrypt error does NOT populate the cache — the corrected key is
 *       picked up on the very next call without a cache wait.
 *   (b) After the key is fixed, the next call uses the corrected key
 *       immediately (no 30-second wait).
 *   (c) A DB error falls through to the env-var fallback without caching —
 *       the next call re-queries the DB rather than serving a stale entry.
 *
 * All external I/O is mocked:
 *   - `@workspace/db`      → vi.mock (DB never touched)
 *   - `./envCrypto.js`     → vi.mock (decrypt is a controlled stub)
 *   - `openai`             → vi.mock (no real HTTP; constructor-safe stub)
 *   - `@anthropic-ai/sdk`  → vi.mock (no real HTTP; constructor-safe stub)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────────
// vi.hoisted() runs before module resolution so these refs are safe to use
// inside vi.mock() factory callbacks.

const { mockLimit, mockWhere, mockFrom, mockSelect } = vi.hoisted(() => {
  const mockLimit  = vi.fn().mockResolvedValue([]);
  const mockWhere  = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom   = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  return { mockLimit, mockWhere, mockFrom, mockSelect };
});

const { mockDecrypt } = vi.hoisted(() => {
  const mockDecrypt = vi.fn<(s: string) => string>();
  return { mockDecrypt };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: { select: mockSelect },
  providerConfigsTable: { isActive: "isActive" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ col: _col, val })),
}));

vi.mock("../envCrypto.js", () => ({
  decrypt: mockDecrypt,
}));

// Plain vi.fn() stubs — safe to call with `new` (vitest mock functions are
// regular functions and can act as constructors).
vi.mock("openai", () => ({ default: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));

// ── Import after mocks ────────────────────────────────────────────────────────

import { getProviderClient, _resetProviderCacheForTests } from "../providerClient.js";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const MockOpenAI    = vi.mocked(OpenAI);
const MockAnthropic = vi.mocked(Anthropic);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal active-provider DB row. */
function activeRow(provider = "openai", encryptedApiKey = "enc-key") {
  return { provider, encryptedApiKey, isActive: true };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset the in-process cache so every test starts cold.
  _resetProviderCacheForTests();

  // Clear mock call history.
  mockSelect.mockClear();
  mockFrom.mockClear();
  mockWhere.mockClear();
  mockLimit.mockClear();
  mockDecrypt.mockReset();
  MockOpenAI.mockClear();
  MockAnthropic.mockClear();

  // Default: no active DB provider.
  mockLimit.mockResolvedValue([]);

  // Default: fallback env vars present.
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "env-key";
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://api.openai.com/v1";
  delete process.env.OPENAI_API_KEY;
});

// ── (a) Decrypt error does NOT populate the cache ─────────────────────────────

describe("getProviderClient — decrypt error bypasses cache", () => {
  it("falls back to env-var on decrypt error", async () => {
    mockLimit.mockResolvedValue([activeRow()]);
    mockDecrypt.mockImplementation(() => { throw new Error("decryption failed"); });

    const result = await getProviderClient();

    // Should have fallen through to the env-var fallback (openai client created).
    expect(result.provider).toBe("openai");
    expect(result.openaiClient).toBeDefined();
  });

  it("uses the env-var key (not the DB key) when decrypt fails", async () => {
    mockLimit.mockResolvedValue([activeRow()]);
    mockDecrypt.mockImplementation(() => { throw new Error("bad key"); });

    await getProviderClient();

    // OpenAI should have been constructed with the env-var key.
    expect(MockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "env-key" }),
    );
  });

  it("does NOT cache after a decrypt error — next call re-queries DB", async () => {
    mockLimit.mockResolvedValue([activeRow()]);
    mockDecrypt.mockImplementation(() => { throw new Error("bad key"); });

    // First call — decrypt fails, fallback is used.
    await getProviderClient();

    // Second call — DB should be queried again (not served from cache).
    await getProviderClient();

    expect(mockSelect).toHaveBeenCalledTimes(2);
  });
});

// ── (b) Fixed key is picked up immediately on the next call ───────────────────

describe("getProviderClient — fixed key takes effect immediately", () => {
  it("uses the corrected key on the call immediately after a decrypt failure", async () => {
    mockLimit.mockResolvedValue([activeRow("openai", "enc-fixed")]);

    // First call: decrypt throws.
    mockDecrypt.mockImplementationOnce(() => { throw new Error("corrupt key"); });
    await getProviderClient(); // falls back to env-var

    MockOpenAI.mockClear(); // discard the env-var call

    // Key is now fixed — decrypt succeeds.
    mockDecrypt.mockReturnValue("sk-corrected-key");

    await getProviderClient();

    // The OpenAI constructor should have been called with the corrected key.
    expect(MockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-corrected-key" }),
    );
  });

  it("does not require waiting for the 30-second TTL after a decrypt failure", async () => {
    // Simulate a decrypt failure on call 1, then success on call 2 immediately.
    mockLimit.mockResolvedValue([activeRow("openai", "enc")]);
    mockDecrypt
      .mockImplementationOnce(() => { throw new Error("corrupt"); })
      .mockReturnValueOnce("sk-fresh-key");

    await getProviderClient(); // call 1: decrypt fails, no cache
    const result = await getProviderClient(); // call 2: decrypt succeeds immediately

    expect(result.provider).toBe("openai");
    // DB was queried twice (no cache hit after the error).
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });
});

// ── (c) DB error falls through to env-var without caching ────────────────────

describe("getProviderClient — DB error falls through to env-var without caching", () => {
  it("returns the env-var fallback when the DB query throws", async () => {
    mockLimit.mockRejectedValue(new Error("connection refused"));

    const result = await getProviderClient();

    expect(result.provider).toBe("openai");
    expect(result.openaiClient).toBeDefined();
  });

  it("uses the env-var key when the DB throws", async () => {
    mockLimit.mockRejectedValue(new Error("connection refused"));

    await getProviderClient();

    expect(MockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "env-key" }),
    );
  });

  it("does NOT cache after a DB error — next call re-queries DB", async () => {
    mockLimit
      .mockRejectedValueOnce(new Error("DB timeout"))
      .mockResolvedValueOnce([]); // second call succeeds (no active row)

    await getProviderClient(); // DB error → env-var fallback
    await getProviderClient(); // should re-query, not serve from cache

    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("serves the corrected DB provider immediately after a transient DB error", async () => {
    mockDecrypt.mockReturnValue("sk-db-key");
    mockLimit
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce([activeRow("openai", "enc-ok")]);

    await getProviderClient(); // DB error → env-var

    MockOpenAI.mockClear();

    const result = await getProviderClient(); // DB is back → use DB provider

    expect(result.provider).toBe("openai");
    expect(MockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-db-key" }),
    );
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });
});

// ── Bonus: successful DB provider IS cached ───────────────────────────────────

describe("getProviderClient — successful DB resolution is cached", () => {
  it("returns the cached result on the second call without re-querying DB", async () => {
    mockDecrypt.mockReturnValue("sk-valid");
    mockLimit.mockResolvedValue([activeRow()]);

    await getProviderClient(); // populates cache
    await getProviderClient(); // served from cache

    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("uses the DB provider key, not the env-var key, when DB succeeds", async () => {
    mockDecrypt.mockReturnValue("sk-from-db");
    mockLimit.mockResolvedValue([activeRow()]);

    await getProviderClient();

    expect(MockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-from-db" }),
    );
  });
});

// ── Anthropic provider path ───────────────────────────────────────────────────

describe("getProviderClient — anthropic provider", () => {
  it("returns an anthropicClient when provider is 'anthropic'", async () => {
    mockDecrypt.mockReturnValue("sk-ant-key");
    mockLimit.mockResolvedValue([activeRow("anthropic", "enc-ant")]);

    const result = await getProviderClient();

    expect(result.provider).toBe("anthropic");
    expect(result.anthropicClient).toBeDefined();
    expect(result.openaiClient).toBeUndefined();
    expect(MockAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-ant-key" }),
    );
  });
});

// ── (d) TTL expiry re-queries DB and reflects provider switch ────────────────

describe("getProviderClient — TTL expiry re-queries DB", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-queries DB after the 30-second TTL expires", async () => {
    vi.useFakeTimers();
    mockDecrypt.mockReturnValue("sk-openai");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-openai")]);

    await getProviderClient(); // call 1: populates cache

    vi.advanceTimersByTime(31_000); // advance past 30-second TTL

    await getProviderClient(); // call 2: cache expired → re-queries DB

    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("does NOT re-query DB before the TTL expires", async () => {
    vi.useFakeTimers();
    mockDecrypt.mockReturnValue("sk-openai");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-openai")]);

    await getProviderClient(); // populates cache

    vi.advanceTimersByTime(29_000); // still within 30-second window

    await getProviderClient(); // served from cache

    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("picks up the new provider after TTL expires (openai → anthropic)", async () => {
    vi.useFakeTimers();

    // Initial state: openai is the active provider
    mockDecrypt.mockReturnValue("sk-openai");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-openai")]);

    const result1 = await getProviderClient();
    expect(result1.provider).toBe("openai");
    expect(result1.openaiClient).toBeDefined();

    // Admin switches active provider to anthropic in the DB
    mockDecrypt.mockReturnValue("sk-ant-key");
    mockLimit.mockResolvedValue([activeRow("anthropic", "enc-ant")]);

    vi.advanceTimersByTime(31_000); // TTL expires

    const result2 = await getProviderClient();

    expect(result2.provider).toBe("anthropic");
    expect(result2.anthropicClient).toBeDefined();
    expect(result2.openaiClient).toBeUndefined();
  });

  it("constructs the Anthropic SDK (not OpenAI) after switching provider past TTL", async () => {
    vi.useFakeTimers();

    mockDecrypt.mockReturnValue("sk-openai");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-openai")]);
    await getProviderClient(); // openai cached

    MockOpenAI.mockClear();
    MockAnthropic.mockClear();

    // Switch to anthropic in DB
    mockDecrypt.mockReturnValue("sk-anthropic-key");
    mockLimit.mockResolvedValue([activeRow("anthropic", "enc-ant")]);

    vi.advanceTimersByTime(31_000); // expire cache

    await getProviderClient();

    expect(MockAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-anthropic-key" }),
    );
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("re-queries DB exactly twice when TTL elapses once between calls", async () => {
    vi.useFakeTimers();

    mockDecrypt.mockReturnValue("sk-openai");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-openai")]);

    await getProviderClient(); // call 1 — cache populated
    await getProviderClient(); // call 2 — cache hit (no re-query)

    vi.advanceTimersByTime(31_000); // TTL expires

    await getProviderClient(); // call 3 — cache miss → re-query
    await getProviderClient(); // call 4 — fresh cache hit (no re-query)

    expect(mockSelect).toHaveBeenCalledTimes(2); // calls 1 and 3
  });
});

// ── (e) Admin deactivates provider mid-session ───────────────────────────────
//
// When a valid cache entry exists but the admin removes or deactivates the
// provider row (isActive → false), the next re-query should find no active
// row, clear _providerCache, and fall through to the env-var fallback
// immediately — not after the remaining TTL window.

describe("getProviderClient — admin deactivates provider mid-session", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the cache and falls back to env-var when the active provider is deactivated after TTL", async () => {
    vi.useFakeTimers();
    mockDecrypt.mockReturnValue("sk-db-key");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-openai")]);

    await getProviderClient(); // call 1 — populates cache

    // Admin deactivates the provider; DB now returns no active row.
    mockLimit.mockResolvedValue([]);

    vi.advanceTimersByTime(31_000); // TTL expires → next call re-queries DB

    const result = await getProviderClient(); // call 2 — finds no active row

    expect(result.provider).toBe("openai"); // env-var fallback
    expect(result.openaiClient).toBeDefined();
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("uses the env-var key (not the stale cached DB key) after provider is deactivated", async () => {
    vi.useFakeTimers();
    mockDecrypt.mockReturnValue("sk-db-key");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-openai")]);

    await getProviderClient(); // cache populated with "sk-db-key"
    MockOpenAI.mockClear();

    // Provider deactivated.
    mockLimit.mockResolvedValue([]);
    vi.advanceTimersByTime(31_000);

    await getProviderClient();

    // Must use the env-var key, not the previously cached DB key.
    expect(MockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "env-key" }),
    );
    expect(MockOpenAI).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-db-key" }),
    );
  });

  it("clears _providerCache so subsequent requests also re-query the DB", async () => {
    vi.useFakeTimers();
    mockDecrypt.mockReturnValue("sk-db-key");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-openai")]);

    await getProviderClient(); // call 1 — cache populated

    // Provider deactivated.
    mockLimit.mockResolvedValue([]);
    vi.advanceTimersByTime(31_000);

    await getProviderClient(); // call 2 — deactivated: cache cleared, env-var used
    await getProviderClient(); // call 3 — cache still null: re-queries DB again

    // DB queried on calls 1, 2, and 3 (cache never re-populated after deactivation).
    expect(mockSelect).toHaveBeenCalledTimes(3);
  });

  it("falls back to env-var immediately when admin calls resetProviderCache before TTL expires", async () => {
    vi.useFakeTimers();
    mockDecrypt.mockReturnValue("sk-db-key");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-openai")]);

    await getProviderClient(); // cache populated, TTL window still open

    // Admin deactivates provider and the admin route calls resetProviderCache().
    mockLimit.mockResolvedValue([]);
    _resetProviderCacheForTests(); // simulates resetProviderCache() called by admin route

    // No time advance — cache was manually cleared, not TTL-expired.
    const result = await getProviderClient();

    expect(result.provider).toBe("openai"); // env-var fallback
    expect(MockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "env-key" }),
    );
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });
});

// ── (f) Key revoked mid-session (cache valid → key nulled/corrupt → failover) ──
//
// Scenario: a valid DB key is cached, the admin revokes it
// (encryptedApiKey set to null, or re-encrypted with a different secret),
// and then calls resetProviderCache() so the stale cache entry is discarded.
// The very next AI request must fall back to env-var without throwing, and
// the cache must NOT be repopulated on fallback so subsequent requests
// continue to re-query the DB.

describe("getProviderClient — key revoked mid-session", () => {
  it("falls back to env-var immediately after cache reset + key nulled in DB", async () => {
    // Step 1: populate the cache with a valid DB key.
    mockDecrypt.mockReturnValue("sk-valid-key");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-valid")]);
    await getProviderClient(); // cache is now warm

    // Step 2: admin nulls the encryptedApiKey in DB and calls resetProviderCache().
    mockLimit.mockResolvedValue([{ provider: "openai", encryptedApiKey: null, isActive: true }]);
    _resetProviderCacheForTests(); // simulates resetProviderCache() called by admin route

    // Step 3: next AI request — must use env-var fallback without throwing.
    const result = await getProviderClient();

    expect(result.provider).toBe("openai");
    expect(result.openaiClient).toBeDefined();
  });

  it("uses the env-var key (not the revoked DB key) after mid-session revocation", async () => {
    mockDecrypt.mockReturnValue("sk-valid-key");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-valid")]);
    await getProviderClient(); // cache warm with "sk-valid-key"
    MockOpenAI.mockClear();

    // Admin nulls the key and resets cache.
    mockLimit.mockResolvedValue([{ provider: "openai", encryptedApiKey: null, isActive: true }]);
    _resetProviderCacheForTests();

    await getProviderClient();

    expect(MockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "env-key" }),
    );
    expect(MockOpenAI).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-valid-key" }),
    );
  });

  it("falls back to env-var immediately after cache reset + key re-encrypted with wrong secret", async () => {
    // Step 1: populate cache.
    mockDecrypt.mockReturnValue("sk-valid-key");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-valid")]);
    await getProviderClient();

    // Step 2: admin re-encrypts with a different secret — decrypt now throws.
    mockDecrypt.mockImplementation(() => { throw new Error("bad decrypt — wrong secret"); });
    mockLimit.mockResolvedValue([activeRow("openai", "enc-new-secret")]);
    _resetProviderCacheForTests();

    // Step 3: next request — decrypt fails, must fall back to env-var without throwing.
    const result = await getProviderClient();

    expect(result.provider).toBe("openai");
    expect(result.openaiClient).toBeDefined();
  });

  it("does NOT re-populate the cache on env-var fallback after revocation — next call re-queries DB", async () => {
    // Populate cache.
    mockDecrypt.mockReturnValue("sk-valid-key");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-valid")]);
    await getProviderClient(); // call 1 — cache warm

    // Admin nulls the key and resets cache.
    mockLimit.mockResolvedValue([{ provider: "openai", encryptedApiKey: null, isActive: true }]);
    _resetProviderCacheForTests();

    await getProviderClient(); // call 2 — env-var fallback (null key in DB)
    await getProviderClient(); // call 3 — must re-query DB, not serve from cache

    // DB queried on calls 1, 2, and 3 (fallback must never re-populate the cache).
    expect(mockSelect).toHaveBeenCalledTimes(3);
  });

  it("picks up a freshly fixed key on the very next request after revocation + re-provision", async () => {
    // Populate cache.
    mockDecrypt.mockReturnValue("sk-valid-key");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-valid")]);
    await getProviderClient(); // cache warm

    // Admin revokes key → cache reset → env-var fallback.
    mockLimit.mockResolvedValue([{ provider: "openai", encryptedApiKey: null, isActive: true }]);
    _resetProviderCacheForTests();
    await getProviderClient(); // env-var fallback

    MockOpenAI.mockClear();

    // Admin provisions a new valid key.
    mockDecrypt.mockReturnValue("sk-replacement-key");
    mockLimit.mockResolvedValue([activeRow("openai", "enc-replacement")]);

    const result = await getProviderClient(); // must pick up new DB key immediately

    expect(result.provider).toBe("openai");
    expect(MockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-replacement-key" }),
    );
  });
});

// ── No provider configured at all ────────────────────────────────────────────

describe("getProviderClient — no provider configured", () => {
  it("throws when no DB provider and no env-var key are present", async () => {
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    mockLimit.mockResolvedValue([]);

    await expect(getProviderClient()).rejects.toThrow("No AI provider configured");
  });
});
