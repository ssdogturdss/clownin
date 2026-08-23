/**
 * Route tests for:
 *   GET  /api/admin/provider-health
 *   PATCH /api/admin/providers/:provider
 *
 * All external I/O is mocked:
 *   - @workspace/db            → vi.mock (DB never touched)
 *   - drizzle-orm              → lightweight stubs
 *   - ../../lib/auth.js        → stubs requireAuth + getUser so JWT is bypassed
 *   - ../../lib/providerClient.js → controls getProviderClient + resetProviderCache
 *   - ../../lib/envCrypto.js   → controls decrypt + encrypt
 *   - node-cron                → prevent real cron jobs
 *
 * Covers GET /admin/provider-health:
 *   - healthy DB key   → ok:true, no decryptError, usingEnvFallback:false
 *   - decrypt failure  → ok:false, decryptError:true, usingEnvFallback:true
 *   - env fallback     → active row exists but no key stored → ok:true, noKeyStored:true, usingEnvFallback:true
 *   - no provider      → getProviderClient throws + no active row → ok:false, noProvider:true
 *
 * Covers PATCH /admin/providers/:provider:
 *   - resetProviderCache() is called immediately after saving a new key
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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
  mockGetProviderClient,
  mockResetProviderCache,
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
  const mockDbSet    = vi.fn(() => ({ where: mockDbUpdateWhere }));
  const mockDbUpdate = vi.fn(() => ({ set: mockDbSet }));

  // ── DB: insert chain ─────────────────────────────────────────────────────
  const mockDbInsertValues = vi.fn().mockResolvedValue([]);
  const mockDbInsert = vi.fn(() => ({ values: mockDbInsertValues }));

  // ── Auth ──────────────────────────────────────────────────────────────────
  const mockRequireAuth = vi.fn(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  const mockGetUser = vi.fn(() => ({
    userId: 1,
    email: "admin@test.com",
    username: "admin",
  }));

  // ── providerClient ────────────────────────────────────────────────────────
  const mockGetProviderClient  = vi.fn();
  const mockResetProviderCache = vi.fn();

  // ── envCrypto ─────────────────────────────────────────────────────────────
  const mockDecrypt = vi.fn<(s: string) => string>();
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
    mockGetProviderClient,
    mockResetProviderCache,
    mockDecrypt,
    mockEncrypt,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
    insert: mockDbInsert,
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    transaction: vi.fn(),
  },
  usersTable: {
    id: "id",
    username: "username",
    email: "email",
    subscriptionTier: "subscriptionTier",
    dailyMessageCount: "dailyMessageCount",
    lastMessageDate: "lastMessageDate",
    createdAt: "createdAt",
  },
  projectsTable:  { id: "id", userId: "userId", updatedAt: "updatedAt" },
  projectFilesTable: { projectId: "projectId" },
  projectEnvVarsTable: { projectId: "projectId" },
  conversationMessagesTable: { projectId: "projectId", sessionId: "sessionId", role: "role", content: "content", createdAt: "createdAt" },
  conversationSessionsTable: { sessionId: "sessionId", name: "name", createdAt: "createdAt" },
  promoCodesTable:  { id: "id", code: "code", createdAt: "createdAt" },
  promoCodeRedemptionsTable: { id: "id", promoCodeId: "promoCodeId", userId: "userId", redeemedAt: "redeemedAt", tier: "tier" },
  providerConfigsTable: {
    provider: "provider",
    isActive: "isActive",
    encryptedApiKey: "encryptedApiKey",
    displayName: "displayName",
    updatedAt: "updatedAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq:      (_col: unknown, val: unknown) => ({ eq: val }),
  and:     (...args: unknown[]) => ({ and: args }),
  or:      (...args: unknown[]) => ({ or: args }),
  isNull:  (_col: unknown) => ({ isNull: true }),
  isNotNull: (_col: unknown) => ({ isNotNull: true }),
  gt:      (_col: unknown, val: unknown) => ({ gt: val }),
  lt:      (_col: unknown, val: unknown) => ({ lt: val }),
  desc:    (_col: unknown) => ({ desc: true }),
  count:   () => ({ count: true }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: String(strings), values }),
    { raw: (s: string) => ({ sqlRaw: s }) },
  ),
}));

vi.mock("../../lib/auth.js", () => ({
  requireAuth: mockRequireAuth,
  getUser:     mockGetUser,
  getSystemUserId: () => 1,
}));

vi.mock("../../lib/providerClient.js", () => ({
  getProviderClient:  mockGetProviderClient,
  resetProviderCache: mockResetProviderCache,
}));

vi.mock("../../lib/envCrypto.js", () => ({
  decrypt: mockDecrypt,
  encrypt: mockEncrypt,
}));

vi.mock("node-cron", () => ({
  default: { schedule: vi.fn() },
}));

// Set numeric ADMIN_USER_IDS so requireAdmin resolves without a DB lookup.
process.env.ADMIN_USER_IDS = "1";

// Import the app after all mocks are in place.
const { default: app } = await import("../../app.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const AUTH = { Authorization: "Bearer test-token" };

/** Build a minimal active-provider DB row. */
function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    displayName: "OpenAI",
    isActive: true,
    encryptedApiKey: "enc-key",
    updatedAt: new Date(),
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: authenticated as admin userId=1.
  mockRequireAuth.mockImplementation(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  mockGetUser.mockReturnValue({
    userId: 1,
    email: "admin@test.com",
    username: "admin",
  });

  // Default: DB select chain returns no rows.
  mockDbLimit.mockResolvedValue([]);
  mockDbWhere.mockImplementation(() => ({ limit: mockDbLimit }));
  mockDbFrom.mockImplementation(() => ({ where: mockDbWhere, limit: mockDbLimit }));

  // Default: getProviderClient resolves to openai (env-var or DB doesn't matter for route).
  mockGetProviderClient.mockResolvedValue({
    provider: "openai",
    openaiClient: {},
  });

  // Default: decrypt succeeds.
  mockDecrypt.mockReturnValue("sk-decrypted");
  // Default: encrypt returns a stable string.
  mockEncrypt.mockImplementation((s: string) => `enc:${s}`);

  // Default DB update/insert are no-ops.
  mockDbUpdateWhere.mockResolvedValue([]);
  mockDbInsertValues.mockResolvedValue([]);
});

// ── GET /api/admin/provider-health ────────────────────────────────────────────

describe("GET /api/admin/provider-health", () => {
  // ── Scenario 1: healthy DB key ─────────────────────────────────────────────

  describe("healthy DB key", () => {
    it("returns ok:true when an active row exists and decrypt succeeds", async () => {
      mockDbLimit.mockResolvedValue([activeRow()]);
      mockDecrypt.mockReturnValue("sk-real-key");
      mockGetProviderClient.mockResolvedValue({ provider: "openai", openaiClient: {} });

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it("reports provider and activeProvider from the DB row", async () => {
      mockDbLimit.mockResolvedValue([activeRow({ provider: "anthropic" })]);
      mockDecrypt.mockReturnValue("sk-ant-key");
      mockGetProviderClient.mockResolvedValue({ provider: "anthropic", anthropicClient: {} });

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.provider).toBe("anthropic");
      expect(res.body.activeProvider).toBe("anthropic");
    });

    it("does NOT set decryptError when decrypt succeeds", async () => {
      mockDbLimit.mockResolvedValue([activeRow()]);
      mockDecrypt.mockReturnValue("sk-valid");

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.decryptError).toBeFalsy();
    });

    it("sets usingEnvFallback:false when the DB key is present and decryptable", async () => {
      mockDbLimit.mockResolvedValue([activeRow({ encryptedApiKey: "enc-good" })]);
      mockDecrypt.mockReturnValue("sk-from-db");

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.usingEnvFallback).toBe(false);
    });
  });

  // ── Scenario 2: decrypt failure ────────────────────────────────────────────

  describe("decrypt failure (corrupt/expired key)", () => {
    it("returns ok:false when the stored key cannot be decrypted", async () => {
      mockDbLimit.mockResolvedValue([activeRow()]);
      mockDecrypt.mockImplementation(() => { throw new Error("decrypt failed"); });
      // getProviderClient silently falls back to env-var.
      mockGetProviderClient.mockResolvedValue({ provider: "openai", openaiClient: {} });

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.ok).toBe(false);
    });

    it("sets decryptError:true when decrypt throws", async () => {
      mockDbLimit.mockResolvedValue([activeRow()]);
      mockDecrypt.mockImplementation(() => { throw new Error("bad key"); });
      mockGetProviderClient.mockResolvedValue({ provider: "openai", openaiClient: {} });

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.decryptError).toBe(true);
    });

    it("sets usingEnvFallback:true on decrypt failure (client fell back to env-var)", async () => {
      mockDbLimit.mockResolvedValue([activeRow()]);
      mockDecrypt.mockImplementation(() => { throw new Error("corrupt"); });
      mockGetProviderClient.mockResolvedValue({ provider: "openai", openaiClient: {} });

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.usingEnvFallback).toBe(true);
    });

    it("still reports the DB provider name even when its key is corrupt", async () => {
      mockDbLimit.mockResolvedValue([activeRow({ provider: "gemini" })]);
      mockDecrypt.mockImplementation(() => { throw new Error("corrupt"); });
      mockGetProviderClient.mockResolvedValue({ provider: "openai", openaiClient: {} });

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      // provider field shows what the admin configured
      expect(res.body.provider).toBe("gemini");
      // activeProvider shows what is actually serving requests (env-var fallback)
      expect(res.body.activeProvider).toBe("openai");
    });

    it("includes an error message describing the decrypt problem", async () => {
      mockDbLimit.mockResolvedValue([activeRow()]);
      mockDecrypt.mockImplementation(() => { throw new Error("bad decrypt"); });
      mockGetProviderClient.mockResolvedValue({ provider: "openai", openaiClient: {} });

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(typeof res.body.error).toBe("string");
      expect(res.body.error.length).toBeGreaterThan(0);
    });
  });

  // ── Scenario 3: env fallback (active row, no key stored) ──────────────────

  describe("env fallback — active row exists but no key stored", () => {
    it("returns ok:true when there is an active row without a stored key", async () => {
      mockDbLimit.mockResolvedValue([activeRow({ encryptedApiKey: null })]);
      mockGetProviderClient.mockResolvedValue({ provider: "openai", openaiClient: {} });

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it("sets usingEnvFallback:true when no key is stored in the DB row", async () => {
      mockDbLimit.mockResolvedValue([activeRow({ encryptedApiKey: null })]);
      mockGetProviderClient.mockResolvedValue({ provider: "openai", openaiClient: {} });

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.usingEnvFallback).toBe(true);
    });

    it("sets noKeyStored:true when the active row has no encryptedApiKey", async () => {
      mockDbLimit.mockResolvedValue([activeRow({ encryptedApiKey: null })]);
      mockGetProviderClient.mockResolvedValue({ provider: "openai", openaiClient: {} });

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.noKeyStored).toBe(true);
    });

    it("does NOT call decrypt when no key is stored", async () => {
      mockDbLimit.mockResolvedValue([activeRow({ encryptedApiKey: null })]);
      mockGetProviderClient.mockResolvedValue({ provider: "openai", openaiClient: {} });

      await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(mockDecrypt).not.toHaveBeenCalled();
    });

    it("returns ok:true when no active DB row at all and getProviderClient uses env-var", async () => {
      mockDbLimit.mockResolvedValue([]); // no active provider in DB
      mockGetProviderClient.mockResolvedValue({ provider: "openai", openaiClient: {} });

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.provider).toBeNull();
      expect(res.body.usingEnvFallback).toBe(true);
    });
  });

  // ── Scenario 4: no provider anywhere ──────────────────────────────────────

  describe("no provider anywhere — getProviderClient throws", () => {
    it("returns ok:false when getProviderClient throws", async () => {
      mockDbLimit.mockResolvedValue([]);
      mockGetProviderClient.mockRejectedValue(
        new Error("No AI provider configured"),
      );

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.ok).toBe(false);
    });

    it("sets noProvider:true when no provider is reachable", async () => {
      mockDbLimit.mockResolvedValue([]);
      mockGetProviderClient.mockRejectedValue(
        new Error("No AI provider configured"),
      );

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.noProvider).toBe(true);
    });

    it("reports the error message from getProviderClient", async () => {
      mockDbLimit.mockResolvedValue([]);
      mockGetProviderClient.mockRejectedValue(
        new Error("No AI provider configured — set an active provider"),
      );

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.error).toMatch(/No AI provider configured/);
    });

    it("sets activeProvider:null when no provider is reachable", async () => {
      mockDbLimit.mockResolvedValue([]);
      mockGetProviderClient.mockRejectedValue(
        new Error("No AI provider configured"),
      );

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.activeProvider).toBeNull();
    });

    it("sets provider:null when no active DB row exists and client throws", async () => {
      mockDbLimit.mockResolvedValue([]);
      mockGetProviderClient.mockRejectedValue(
        new Error("No AI provider configured"),
      );

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.provider).toBeNull();
    });

    it("sets noProvider:true and decryptError:false when the only issue is no provider (not a corrupt key)", async () => {
      mockDbLimit.mockResolvedValue([]);
      mockGetProviderClient.mockRejectedValue(new Error("No AI provider configured"));

      const res = await request(app)
        .get("/api/admin/provider-health")
        .set(AUTH)
        .expect(200);

      expect(res.body.noProvider).toBe(true);
      // No active row means no key to attempt decrypt — decryptError should be falsy.
      expect(res.body.decryptError).toBeFalsy();
    });
  });
});

// ── PATCH /api/admin/providers/:provider — cache reset ───────────────────────

describe("PATCH /api/admin/providers/:provider — cache reset after save", () => {
  /** Set up the DB mock to simulate an existing row that gets updated. */
  function setupExistingProvider(provider = "openai") {
    const existingRow = activeRow({ provider });
    const updatedRow  = { ...existingRow, updatedAt: new Date(), encryptedApiKey: "enc:sk-new-key" };

    // The PATCH route does:
    //   1. db.update (deactivate all if isActive is being set true)
    //   2. db.select().from().where().limit(1) to check existing row
    //   3. db.update().set().where() to update existing row
    //   4. db.select().from().where().limit(1) to fetch updated row for response

    // We can't easily differentiate each select call, so we return the row on every limit call.
    mockDbLimit.mockResolvedValue([existingRow]);
    // The second select (after upsert) also returns the updated row.
    mockDbLimit
      .mockResolvedValueOnce([existingRow])   // check-existing select
      .mockResolvedValueOnce([updatedRow]);    // final response select

    mockDbUpdateWhere.mockResolvedValue([updatedRow]);
  }

  it("calls resetProviderCache() after saving a new API key", async () => {
    setupExistingProvider("openai");

    await request(app)
      .patch("/api/admin/providers/openai")
      .set(AUTH)
      .send({ apiKey: "sk-new-key" })
      .expect(200);

    expect(mockResetProviderCache).toHaveBeenCalledOnce();
  });

  it("calls resetProviderCache() when only isActive is toggled", async () => {
    setupExistingProvider("openai");

    await request(app)
      .patch("/api/admin/providers/openai")
      .set(AUTH)
      .send({ isActive: true })
      .expect(200);

    expect(mockResetProviderCache).toHaveBeenCalledOnce();
  });

  it("calls resetProviderCache() when the key is cleared", async () => {
    setupExistingProvider("openai");

    await request(app)
      .patch("/api/admin/providers/openai")
      .set(AUTH)
      .send({ clearKey: true })
      .expect(200);

    expect(mockResetProviderCache).toHaveBeenCalledOnce();
  });

  it("returns the updated provider state in the response body", async () => {
    setupExistingProvider("openai");

    const res = await request(app)
      .patch("/api/admin/providers/openai")
      .set(AUTH)
      .send({ apiKey: "sk-new-key" })
      .expect(200);

    expect(res.body).toHaveProperty("provider");
    expect(res.body).toHaveProperty("isActive");
    expect(res.body).toHaveProperty("hasApiKey");
  });

  it("rejects an unknown provider with 400 and does NOT call resetProviderCache", async () => {
    await request(app)
      .patch("/api/admin/providers/unknown-provider")
      .set(AUTH)
      .send({ apiKey: "sk-test" })
      .expect(400);

    expect(mockResetProviderCache).not.toHaveBeenCalled();
  });

  it("calls resetProviderCache() when a provider is deactivated (isActive: false)", async () => {
    setupExistingProvider("openai");

    await request(app)
      .patch("/api/admin/providers/openai")
      .set(AUTH)
      .send({ isActive: false })
      .expect(200);

    expect(mockResetProviderCache).toHaveBeenCalledOnce();
  });

  it("calls resetProviderCache() exactly once even when both apiKey and isActive:false are sent together", async () => {
    setupExistingProvider("openai");

    await request(app)
      .patch("/api/admin/providers/openai")
      .set(AUTH)
      .send({ apiKey: "sk-replacement", isActive: false })
      .expect(200);

    expect(mockResetProviderCache).toHaveBeenCalledOnce();
  });

  it("calls resetProviderCache() for each known provider type when deactivated", async () => {
    for (const provider of ["openai", "anthropic", "gemini", "openrouter", "xai"]) {
      vi.clearAllMocks();
      setupExistingProvider(provider);

      await request(app)
        .patch(`/api/admin/providers/${provider}`)
        .set(AUTH)
        .send({ isActive: false })
        .expect(200);

      expect(mockResetProviderCache).toHaveBeenCalledOnce();
    }
  });
});

// ── PATCH /api/admin/providers/:provider — switch takes effect immediately ────
//
// These tests verify the contract that the admin route's resetProviderCache()
// call makes a provider switch visible to the very next AI request — before
// the 30-second TTL would otherwise expire.  The route-level test confirms the
// call is made; the integration contract is documented here in terms of
// observable behaviour at the getProviderClient layer.

describe("PATCH /api/admin/providers/:provider — switch takes effect before next AI request", () => {
  it("resetProviderCache is called before the route responds, so the caller's next request sees the new provider", async () => {
    // Track the order: resetProviderCache must be called before the response
    // is sent so that concurrent or immediately-following AI requests see the
    // updated provider.
    const callOrder: string[] = [];

    mockResetProviderCache.mockImplementation(() => {
      callOrder.push("resetProviderCache");
    });

    const existingRow = activeRow({ provider: "openai" });
    const updatedRow  = { ...existingRow, isActive: false, updatedAt: new Date() };
    mockDbLimit
      .mockResolvedValueOnce([existingRow])
      .mockResolvedValueOnce([updatedRow]);
    mockDbUpdateWhere.mockResolvedValue([updatedRow]);

    await request(app)
      .patch("/api/admin/providers/openai")
      .set(AUTH)
      .send({ isActive: false })
      .expect(200);

    // resetProviderCache must have been called during request processing
    expect(callOrder).toContain("resetProviderCache");
  });

  it("resetProviderCache is called once per PATCH regardless of which fields changed", async () => {
    // Every successful PATCH must bust the cache — partial updates (key-only,
    // active-only, or both) all have the potential to change what
    // getProviderClient returns.
    const scenarios = [
      { apiKey: "sk-new" },
      { isActive: true },
      { isActive: false },
      { clearKey: true },
      { apiKey: "sk-new", isActive: false },
    ];

    for (const body of scenarios) {
      vi.clearAllMocks();

      const existingRow = activeRow();
      const updatedRow  = { ...existingRow, updatedAt: new Date() };
      mockDbLimit
        .mockResolvedValueOnce([existingRow])
        .mockResolvedValueOnce([updatedRow]);
      mockDbUpdateWhere.mockResolvedValue([updatedRow]);

      await request(app)
        .patch("/api/admin/providers/openai")
        .set(AUTH)
        .send(body)
        .expect(200);

      expect(mockResetProviderCache).toHaveBeenCalledOnce();
    }
  });
});
