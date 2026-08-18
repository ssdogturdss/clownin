/**
 * Integration tests: PATCH /api/admin/providers/:provider
 *   using the REAL providerClient.js (intentionally NOT mocked).
 *
 * Purpose: prove that an admin provider switch takes effect on the very next
 * call to getProviderClient() without waiting for the 30-second TTL to expire.
 *
 * Mocked (external I/O only):
 *   - @workspace/db        — controlled DB responses; never touches real DB
 *   - drizzle-orm          — lightweight stubs
 *   - ../../lib/auth.js    — bypass JWT verification
 *   - ../../lib/envCrypto.js — controlled encrypt/decrypt; no real secrets
 *   - openai               — constructor stub; no real HTTP
 *   - @anthropic-ai/sdk    — constructor stub; no real HTTP
 *   - node-cron            — prevent real cron jobs
 *   - ../../lib/subscriptionSync.js — prevent cron side-effects
 *
 * NOT mocked (the real implementation):
 *   - ../../lib/providerClient.js
 *     → _providerCache is the live module-level variable; PATCH must clear it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// ── Hoisted mock state ────────────────────────────────────────────────────────

const {
  mockDbSelect,
  mockDbFrom,
  mockDbWhere,
  mockDbLimit,
  mockDbUpdate,
  mockDbSet,
  mockDbUpdateWhere,
  mockDbInsert,
  mockDbInsertValues,
  mockRequireAuth,
  mockGetUser,
  mockDecrypt,
  mockEncrypt,
} = vi.hoisted(() => {
  // ── DB: select chain ─────────────────────────────────────────────────────
  const mockDbLimit  = vi.fn().mockResolvedValue([]);
  const mockDbWhere  = vi.fn(() => ({ limit: mockDbLimit }));
  const mockDbFrom   = vi.fn(() => ({ where: mockDbWhere, limit: mockDbLimit }));
  const mockDbSelect = vi.fn(() => ({ from: mockDbFrom }));

  // ── DB: update chain ─────────────────────────────────────────────────────
  const mockDbUpdateWhere = vi.fn().mockResolvedValue([]);
  const mockDbSet         = vi.fn(() => ({ where: mockDbUpdateWhere }));
  const mockDbUpdate      = vi.fn(() => ({ set: mockDbSet }));

  // ── DB: insert chain ─────────────────────────────────────────────────────
  const mockDbInsertValues = vi.fn().mockResolvedValue([]);
  const mockDbInsert       = vi.fn(() => ({ values: mockDbInsertValues }));

  // ── Auth ──────────────────────────────────────────────────────────────────
  const mockRequireAuth = vi.fn(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  const mockGetUser = vi.fn(() => ({
    userId: 1,
    email: "admin@test.com",
    username: "admin",
  }));

  // ── envCrypto ─────────────────────────────────────────────────────────────
  const mockDecrypt = vi.fn<(s: string) => string>(() => "sk-decrypted");
  const mockEncrypt = vi.fn<(s: string) => string>((s) => `enc:${s}`);

  return {
    mockDbSelect,
    mockDbFrom,
    mockDbWhere,
    mockDbLimit,
    mockDbUpdate,
    mockDbSet,
    mockDbUpdateWhere,
    mockDbInsert,
    mockDbInsertValues,
    mockRequireAuth,
    mockGetUser,
    mockDecrypt,
    mockEncrypt,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    select:      mockDbSelect,
    update:      mockDbUpdate,
    insert:      mockDbInsert,
    delete:      vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    execute:     vi.fn().mockResolvedValue({ rows: [] }),
    transaction: vi.fn(),
  },
  usersTable:                   { id: "id", username: "username", email: "email", subscriptionTier: "subscriptionTier", dailyMessageCount: "dailyMessageCount", lastMessageDate: "lastMessageDate", createdAt: "createdAt" },
  projectsTable:                { id: "id", userId: "userId", updatedAt: "updatedAt", name: "name", language: "language" },
  projectFilesTable:            { projectId: "projectId" },
  projectEnvVarsTable:          { projectId: "projectId" },
  conversationMessagesTable:    { projectId: "projectId", sessionId: "sessionId", role: "role", content: "content", createdAt: "createdAt" },
  conversationSessionsTable:    { sessionId: "sessionId", name: "name", createdAt: "createdAt" },
  promoCodesTable:              { id: "id", code: "code", createdAt: "createdAt" },
  promoCodeRedemptionsTable:    { id: "id", promoCodeId: "promoCodeId", userId: "userId", redeemedAt: "redeemedAt", tier: "tier" },
  providerConfigsTable: {
    provider:        "provider",
    isActive:        "isActive",
    encryptedApiKey: "encryptedApiKey",
    displayName:     "displayName",
    updatedAt:       "updatedAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq:       (_col: unknown, val: unknown) => ({ eq: val }),
  and:      (...args: unknown[]) => ({ and: args }),
  or:       (...args: unknown[]) => ({ or: args }),
  isNull:   (_col: unknown) => ({ isNull: true }),
  isNotNull:(_col: unknown) => ({ isNotNull: true }),
  gt:       (_col: unknown, val: unknown) => ({ gt: val }),
  lt:       (_col: unknown, val: unknown) => ({ lt: val }),
  desc:     (_col: unknown) => ({ desc: true }),
  count:    () => ({ count: true }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: String(strings), values }),
    { raw: (s: string) => ({ sqlRaw: s }) },
  ),
}));

vi.mock("../../lib/auth.js", () => ({
  requireAuth: mockRequireAuth,
  getUser:     mockGetUser,
}));

// ⚠️  providerClient.js is intentionally NOT mocked here.
//     The real _providerCache is populated and cleared in these tests.

vi.mock("../../lib/envCrypto.js", () => ({
  decrypt: mockDecrypt,
  encrypt: mockEncrypt,
}));

vi.mock("openai", () => ({ default: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("node-cron", () => ({ default: { schedule: vi.fn() } }));

// Set ADMIN_USER_IDS so requireAdmin resolves without a DB lookup.
process.env.ADMIN_USER_IDS = "1";

// Set env-var fallback keys so getProviderClient can fall back to them.
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "env-key";
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://api.openai.com/v1";
delete process.env.OPENAI_API_KEY;

// Import the app AFTER all mocks are in place.
const { default: app } = await import("../../app.js");

// Import the real providerClient so tests can populate and inspect the cache.
const { getProviderClient, _resetProviderCacheForTests } =
  await import("../../lib/providerClient.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const AUTH = { Authorization: "Bearer test-token" };

function dbActiveRow(overrides: Record<string, unknown> = {}) {
  return {
    provider:        "openai",
    displayName:     "OpenAI",
    isActive:        true,
    encryptedApiKey: "enc-real-key",
    updatedAt:       new Date(),
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  // Always start each test with a cold real cache.
  _resetProviderCacheForTests();

  vi.clearAllMocks();

  // Restore DB chain after clearAllMocks
  mockDbWhere.mockImplementation(() => ({ limit: mockDbLimit }));
  mockDbFrom.mockImplementation(() => ({ where: mockDbWhere, limit: mockDbLimit }));
  mockDbSet.mockImplementation(() => ({ where: mockDbUpdateWhere }));

  // Default: no active DB provider (safe baseline).
  mockDbLimit.mockResolvedValue([]);

  // Default: auth passes, user is admin
  mockRequireAuth.mockImplementation(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  mockGetUser.mockReturnValue({ userId: 1, email: "admin@test.com", username: "admin" });

  // Default: decrypt returns a usable key, encrypt is a no-op shim.
  mockDecrypt.mockReturnValue("sk-decrypted");
  mockEncrypt.mockImplementation((s: string) => `enc:${s}`);

  // Default: DB update/insert are no-ops.
  mockDbUpdateWhere.mockResolvedValue([]);
  mockDbInsertValues.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Core integration contract ─────────────────────────────────────────────────
//
// All tests below use the REAL getProviderClient() and REAL _providerCache.
// The PATCH route must call the real resetProviderCache() so that the cache is
// actually cleared — not merely a mock call recorded.

describe("PATCH /api/admin/providers/:provider — real cache cleared before next AI request", () => {

  it("getProviderClient re-queries DB immediately after PATCH without advancing the clock", async () => {
    vi.useFakeTimers(); // freeze time — TTL cannot expire on its own

    // ── Step 1: populate the real cache ─────────────────────────────────────
    mockDbLimit.mockResolvedValueOnce([dbActiveRow()]); // getProviderClient call 1
    mockDecrypt.mockReturnValue("sk-cached-key");

    await getProviderClient(); // _providerCache is now populated (TTL = now + 30 000)

    // ── Step 2: set up DB for the PATCH route's own selects ─────────────────
    // The PATCH (isActive: false, existing row) does:
    //   a) db.select ... .limit(1)  → check-existing
    //   b) db.update ...            → set isActive: false
    //   c) db.select ... .limit(1)  → fetch updated row for response body
    const existingRow = dbActiveRow();
    const deactivatedRow = dbActiveRow({ isActive: false });

    mockDbLimit
      .mockResolvedValueOnce([existingRow])    // (a) check-existing
      .mockResolvedValueOnce([deactivatedRow]) // (c) response fetch
      .mockResolvedValueOnce([]);              // post-PATCH getProviderClient: no active row

    mockDbUpdateWhere.mockResolvedValue([deactivatedRow]);

    // ── Step 3: PATCH — real resetProviderCache() fires inside the handler ──
    await request(app)
      .patch("/api/admin/providers/openai")
      .set(AUTH)
      .send({ isActive: false })
      .expect(200);

    // Time has NOT advanced — zero milliseconds elapsed.
    // The 30-second TTL on the cached entry is still valid according to Date.now().
    // Cache can only be clear because resetProviderCache() was called.

    // ── Step 4: call getProviderClient() — must re-query, not serve cache ───
    mockDbSelect.mockClear(); // isolate: count only selects from this point forward

    const result = await getProviderClient();

    // DB was re-queried (proves cache was cleared by the route, not by TTL).
    expect(mockDbSelect).toHaveBeenCalledOnce();

    // DB returns no active row → falls back to env-var (not the stale cached key).
    expect(result.provider).toBe("openai"); // env-var fallback
  });

  it("uses the env-var key (not the previously cached DB key) immediately after PATCH deactivates the provider", async () => {
    vi.useFakeTimers();

    const { default: MockOpenAI } = await import("openai");
    const MockOpenAICtor = vi.mocked(MockOpenAI);

    // Populate cache with DB key.
    mockDbLimit.mockResolvedValueOnce([dbActiveRow()]);
    mockDecrypt.mockReturnValue("sk-cached-db-key");
    await getProviderClient();

    MockOpenAICtor.mockClear();

    // PATCH: deactivate provider.
    const existingRow    = dbActiveRow();
    const deactivatedRow = dbActiveRow({ isActive: false });
    mockDbLimit
      .mockResolvedValueOnce([existingRow])
      .mockResolvedValueOnce([deactivatedRow])
      .mockResolvedValueOnce([]); // post-PATCH: no active provider

    await request(app)
      .patch("/api/admin/providers/openai")
      .set(AUTH)
      .send({ isActive: false })
      .expect(200);

    // Time still at 0 — TTL has not expired.
    await getProviderClient();

    // Must have been called with the env-var key, not the stale cached DB key.
    expect(MockOpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "env-key" }),
    );
    expect(MockOpenAICtor).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-cached-db-key" }),
    );
  });

  it("the second getProviderClient after PATCH also re-queries (cache not re-populated by env-var fallback)", async () => {
    vi.useFakeTimers();

    // Populate cache.
    mockDbLimit.mockResolvedValueOnce([dbActiveRow()]);
    await getProviderClient();

    // PATCH deactivates.
    const existing    = dbActiveRow();
    const deactivated = dbActiveRow({ isActive: false });
    mockDbLimit
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([deactivated])
      .mockResolvedValueOnce([]) // 1st post-PATCH getProviderClient
      .mockResolvedValueOnce([]); // 2nd post-PATCH getProviderClient

    await request(app)
      .patch("/api/admin/providers/openai")
      .set(AUTH)
      .send({ isActive: false })
      .expect(200);

    mockDbSelect.mockClear();

    await getProviderClient(); // 1st post-PATCH call — re-queries DB
    await getProviderClient(); // 2nd post-PATCH call — must also re-query (env fallback never caches)

    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });

  it("a provider key update via PATCH is visible to getProviderClient on the very next call", async () => {
    vi.useFakeTimers();

    const { default: MockOpenAI } = await import("openai");
    const MockOpenAICtor = vi.mocked(MockOpenAI);

    // Populate cache with old key.
    mockDbLimit.mockResolvedValueOnce([dbActiveRow({ encryptedApiKey: "enc:old" })]);
    mockDecrypt.mockReturnValue("sk-old-key");
    await getProviderClient();

    MockOpenAICtor.mockClear();

    // PATCH: save a new API key (provider stays active).
    const existingRow = dbActiveRow({ encryptedApiKey: "enc:old" });
    const updatedRow  = dbActiveRow({ encryptedApiKey: "enc:sk-new-key" });
    mockDbLimit
      .mockResolvedValueOnce([existingRow])    // check-existing
      .mockResolvedValueOnce([updatedRow]);    // response fetch

    // After PATCH, getProviderClient will call the DB and decrypt will return the new key.
    mockDecrypt.mockReturnValue("sk-new-key");
    mockDbLimit.mockResolvedValueOnce([updatedRow]); // post-PATCH getProviderClient

    await request(app)
      .patch("/api/admin/providers/openai")
      .set(AUTH)
      .send({ apiKey: "sk-new-key" })
      .expect(200);

    // Time still at 0.
    const result = await getProviderClient();

    expect(result.provider).toBe("openai");
    // Constructed with the NEW key, not the cached old key.
    expect(MockOpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-new-key" }),
    );
    expect(MockOpenAICtor).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-old-key" }),
    );
  });

  it("a model override via PATCH is reflected immediately in the next getProviderClient call", async () => {
    vi.useFakeTimers();

    // ── Step 1: populate the real cache with the old model ───────────────────
    const oldRow = dbActiveRow({ encryptedApiKey: "enc:key", model: "gpt-4o" });
    mockDbLimit.mockResolvedValueOnce([oldRow]);
    mockDecrypt.mockReturnValue("sk-key");

    const result1 = await getProviderClient();
    expect(result1.model).toBe("gpt-4o"); // cache is warm with old model

    // ── Step 2: PATCH saves a new model override ─────────────────────────────
    // DB mock sequence for PATCH /admin/providers/openai with { model: "gpt-5" }:
    //   a. db.select ... .limit(1)  → check-existing (existing row)
    //   b. db.update (model = "gpt-5")
    //   c. db.select ... .limit(1)  → fetch updated row for response body
    const existingRow = dbActiveRow({ encryptedApiKey: "enc:key", model: "gpt-4o" });
    const updatedRow  = dbActiveRow({ encryptedApiKey: "enc:key", model: "gpt-5" });
    mockDbLimit
      .mockResolvedValueOnce([existingRow])   // (a) check-existing
      .mockResolvedValueOnce([updatedRow]);   // (c) response fetch

    mockDbUpdateWhere.mockResolvedValue([updatedRow]);

    await request(app)
      .patch("/api/admin/providers/openai")
      .set(AUTH)
      .send({ model: "gpt-5" })
      .expect(200);

    // ── Step 3: next getProviderClient — time has NOT advanced ───────────────
    // The 30-second TTL is still valid. The model update is visible ONLY
    // because resetProviderCache() was called inside the PATCH handler.
    mockDbLimit.mockResolvedValueOnce([updatedRow]); // post-PATCH DB re-query

    mockDbSelect.mockClear();
    const result2 = await getProviderClient();

    // DB was re-queried (proves cache was invalidated by the route, not TTL).
    expect(mockDbSelect).toHaveBeenCalledOnce();
    // Model reflects the new value from the DB, not the stale cached value.
    expect(result2.model).toBe("gpt-5");
  });

  it("switching from openai to anthropic via PATCH is reflected immediately in getProviderClient", async () => {
    vi.useFakeTimers();

    const { default: MockOpenAI }    = await import("openai");
    const { default: MockAnthropic } = await import("@anthropic-ai/sdk");
    const MockOpenAICtor    = vi.mocked(MockOpenAI);
    const MockAnthropicCtor = vi.mocked(MockAnthropic);

    // ── Initial state: openai is active ──────────────────────────────────────
    mockDbLimit.mockResolvedValueOnce([dbActiveRow({ provider: "openai" })]);
    mockDecrypt.mockReturnValue("sk-openai-key");

    const result1 = await getProviderClient();
    expect(result1.provider).toBe("openai");
    expect(result1.openaiClient).toBeDefined();

    MockOpenAICtor.mockClear();
    MockAnthropicCtor.mockClear();

    // ── Admin activates anthropic (PATCH sets isActive: true on anthropic) ──
    // The route first deactivates all others via db.update, then upserts anthropic.
    //
    // DB mock sequence for PATCH /admin/providers/anthropic with { isActive: true }:
    //   1. db.update (deactivate all) — handled by mockDbUpdateWhere
    //   2. db.select ... limit → check-existing for anthropic row (may not exist → insert)
    //   3. db.insert (new row) OR db.update (existing row)
    //   4. db.select ... limit → fetch updated anthropic row for response
    //
    // For simplicity, simulate anthropic as a new row (insert path).
    const anthropicRow = {
      provider: "anthropic", displayName: "Anthropic",
      isActive: true, encryptedApiKey: "enc:sk-ant", updatedAt: new Date(),
    };
    mockDbLimit
      .mockResolvedValueOnce([])            // check-existing: anthropic doesn't exist yet → insert
      .mockResolvedValueOnce([anthropicRow]); // response fetch

    mockDbInsertValues.mockResolvedValue([anthropicRow]);
    mockDbUpdateWhere.mockResolvedValue([]);

    // After PATCH, getProviderClient will re-query and find anthropic active.
    mockDecrypt.mockReturnValue("sk-ant-key");
    mockDbLimit.mockResolvedValueOnce([anthropicRow]);

    await request(app)
      .patch("/api/admin/providers/anthropic")
      .set(AUTH)
      .send({ apiKey: "sk-ant", isActive: true })
      .expect(200);

    // Time has NOT advanced — switch is immediate, not TTL-driven.
    const result2 = await getProviderClient();

    expect(result2.provider).toBe("anthropic");
    expect(result2.anthropicClient).toBeDefined();
    expect(result2.openaiClient).toBeUndefined();

    expect(MockAnthropicCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-ant-key" }),
    );
    expect(MockOpenAICtor).not.toHaveBeenCalled();
  });
});
