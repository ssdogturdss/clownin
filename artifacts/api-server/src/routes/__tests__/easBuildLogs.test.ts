/**
 * Tests for GET /api/eas/builds/:buildId/logs
 *
 * All external I/O is mocked:
 *   - global fetch  → vi.stubGlobal so EAS GraphQL + S3 calls are intercepted
 *   - lib/auth      → requireAuth passes through; getUser returns a fixed user
 *   - node-cron     → no real cron jobs
 *   - @workspace/db → no real DB
 *
 * Admin access is controlled via ADMIN_USER_IDS env var + getUser stub (userId 1),
 * matching the pattern used by promo.test.ts — the admin module is NOT mocked so
 * its default Router export remains intact.
 *
 * Covers:
 *   - 401 when not authenticated
 *   - 403 when user is not in ADMIN_USER_IDS
 *   - 200 with logs fetched from logFileUrls
 *   - 200 concatenating multiple logFileUrls
 *   - 200 with empty logs when logFileUrls is absent and no iOS fallback URL
 *   - 200 via xcodeBuildLogsUrl iOS fallback when logFileUrls is empty
 *   - 502 when EAS GraphQL responds with top-level errors
 *   - 502 when EAS GraphQL returns a non-ok HTTP status
 *   - 503 when EAS_CLOWNIN_KEY is not set
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// ── Hoisted mock state ────────────────────────────────────────────────────────

const { mockFetch, mockRequireAuth, mockGetUser } = vi.hoisted(() => {
  const mockFetch = vi.fn();

  const mockRequireAuth = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
  const mockGetUser     = vi.fn(() => ({ userId: 1, email: "admin@test.com", username: "admin" }));

  return { mockFetch, mockRequireAuth, mockGetUser };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../lib/auth.js", () => ({
  requireAuth: mockRequireAuth,
  getUser:     mockGetUser,
  getSystemUserId: () => 1,
}));

vi.mock("@workspace/db", () => ({
  db: {
    select:      vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
    update:      vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
    insert:      vi.fn(() => ({ values: vi.fn().mockResolvedValue([]) })),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) => cb({})),
  },
  usersTable:                { id: "id", subscriptionTier: "subscriptionTier", email: "email", username: "username" },
  promoCodesTable:           { id: "id", code: "code", tier: "tier", isActive: "isActive", expiresAt: "expiresAt", usedCount: "usedCount", maxUses: "maxUses" },
  promoCodeRedemptionsTable: { id: "id", promoCodeId: "promoCodeId", userId: "userId", redeemedAt: "redeemedAt", tier: "tier" },
  providerConfigsTable:      { provider: "provider", isActive: "isActive", priority: "priority" },
  projectsTable:             { id: "id", userId: "userId", updatedAt: "updatedAt", name: "name", createdAt: "createdAt" },
  projectFilesTable:         { projectId: "projectId" },
  projectEnvVarsTable:       { projectId: "projectId" },
  conversationMessagesTable: { projectId: "projectId", sessionId: "sessionId", role: "role", createdAt: "createdAt" },
  conversationSessionsTable: { id: "id", projectId: "projectId", userId: "userId", name: "name", createdAt: "createdAt", updatedAt: "updatedAt" },
}));

vi.mock("drizzle-orm", () => ({
  eq:        (_col: unknown, val: unknown) => ({ eq: val }),
  and:       (...args: unknown[]) => ({ and: args }),
  or:        (...args: unknown[]) => ({ or: args }),
  isNull:    (_col: unknown) => ({ isNull: true }),
  isNotNull: (_col: unknown) => ({ isNotNull: true }),
  gt:        (_col: unknown, val: unknown) => ({ gt: val }),
  lt:        (_col: unknown, val: unknown) => ({ lt: val }),
  desc:      (_col: unknown) => ({ desc: true }),
  count:     () => ({ count: true }),
  sql:       (s: TemplateStringsArray, ...v: unknown[]) => ({ sql: String(s), v }),
}));

vi.mock("node-cron", () => ({ default: { schedule: vi.fn() } }));

vi.stubGlobal("fetch", mockFetch);

// ── Helpers ───────────────────────────────────────────────────────────────────

const AUTH     = { Authorization: "Bearer test-token" };
const BUILD_ID = "build-abc-123";

/**
 * Wraps a build object in the EAS GraphQL response envelope.
 */
function gqlBuildResponse(build: Record<string, unknown>): Response {
  return {
    ok:   true,
    json: async () => ({ data: { build: { byId: build } } }),
    text: async () => "",
  } as unknown as Response;
}

/** Mock for a presigned S3 plain-text log file. */
function textResponse(body: string): Response {
  return {
    ok:   true,
    text: async () => body,
    json: async () => ({}),
  } as unknown as Response;
}

/** Non-ok HTTP response (e.g. EAS API 500). */
function errorResponse(status = 500): Response {
  return {
    ok:     false,
    status,
    text:   async () => "Internal Server Error",
    json:   async () => ({ errors: [{ message: "Internal Server Error" }] }),
  } as unknown as Response;
}

/** GraphQL response containing a top-level errors array (2xx but failed). */
function gqlErrorResponse(message: string): Response {
  return {
    ok:   true,
    json: async () => ({ errors: [{ message }] }),
    text: async () => "",
  } as unknown as Response;
}

// ── Import app after all mocks ────────────────────────────────────────────────

const { default: app } = await import("../../app.js");

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  process.env["EAS_CLOWNIN_KEY"] = "eas-test-key";
  // userId 1 is admin; tests that need a non-admin override this
  process.env["ADMIN_USER_IDS"]  = "1";

  mockRequireAuth.mockImplementation((_req: unknown, _res: unknown, next: () => void) => next());
  mockGetUser.mockReturnValue({ userId: 1, email: "admin@test.com", username: "admin" });
});

afterEach(() => {
  delete process.env["EAS_CLOWNIN_KEY"];
  delete process.env["ADMIN_USER_IDS"];
});

// ── Auth guards ───────────────────────────────────────────────────────────────

describe("GET /api/eas/builds/:buildId/logs — auth guards", () => {
  it("returns 401 when not authenticated", async () => {
    mockRequireAuth.mockImplementation(
      (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
        res.status(401).json({ error: "Unauthorized" }),
    );

    const res = await request(app).get(`/api/eas/builds/${BUILD_ID}/logs`);
    expect(res.status).toBe(401);
  });

  it("returns 403 when user is not in ADMIN_USER_IDS", async () => {
    // userId 999 is not admin
    mockGetUser.mockReturnValue({ userId: 999, email: "user@test.com", username: "user" });

    const res = await request(app)
      .get(`/api/eas/builds/${BUILD_ID}/logs`)
      .set(AUTH);
    expect(res.status).toBe(403);
  });
});

// ── logFileUrls path ──────────────────────────────────────────────────────────

describe("GET /api/eas/builds/:buildId/logs — logFileUrls", () => {
  it("returns 200 with log lines split from a single logFileUrl", async () => {
    const logText = "line one\nline two\nline three";

    mockFetch
      .mockResolvedValueOnce(
        gqlBuildResponse({
          id:          BUILD_ID,
          status:      "FINISHED",
          platform:    "ANDROID",
          createdAt:   "2026-08-22T10:00:00Z",
          metrics:     { buildDuration: 120 },
          logFileUrls: ["https://s3.example.com/build.log"],
          artifacts:   { buildUrl: "https://cdn.example.com/app.apk" },
        }),
      )
      .mockResolvedValueOnce(textResponse(logText));

    const res = await request(app)
      .get(`/api/eas/builds/${BUILD_ID}/logs`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("FINISHED");
    expect(res.body.platform).toBe("ANDROID");
    expect(res.body.durationSeconds).toBe(120);
    expect(res.body.buildUrl).toBe("https://cdn.example.com/app.apk");
    expect(res.body.logs).toEqual(["line one", "line two", "line three"]);
  });

  it("concatenates multiple logFileUrls into a single log array", async () => {
    mockFetch
      .mockResolvedValueOnce(
        gqlBuildResponse({
          id:          BUILD_ID,
          status:      "FINISHED",
          platform:    "IOS",
          createdAt:   "2026-08-22T10:00:00Z",
          logFileUrls: ["https://s3.example.com/log1.txt", "https://s3.example.com/log2.txt"],
          artifacts:   {},
        }),
      )
      .mockResolvedValueOnce(textResponse("part-one"))
      .mockResolvedValueOnce(textResponse("part-two"));

    const res = await request(app)
      .get(`/api/eas/builds/${BUILD_ID}/logs`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.logs).toContain("part-one");
    expect(res.body.logs).toContain("part-two");
  });
});

// ── Absent logs ───────────────────────────────────────────────────────────────

describe("GET /api/eas/builds/:buildId/logs — absent logs", () => {
  it("returns 200 with empty logs when logFileUrls is absent and no xcodeBuildLogsUrl", async () => {
    mockFetch.mockResolvedValueOnce(
      gqlBuildResponse({
        id:        BUILD_ID,
        status:    "IN_QUEUE",
        platform:  "IOS",
        createdAt: "2026-08-22T11:00:00Z",
        artifacts: {},
      }),
    );

    const res = await request(app)
      .get(`/api/eas/builds/${BUILD_ID}/logs`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("IN_QUEUE");
    expect(res.body.logs).toEqual([]);
  });
});

// ── iOS xcodeBuildLogsUrl fallback ────────────────────────────────────────────

describe("GET /api/eas/builds/:buildId/logs — iOS xcodeBuildLogsUrl fallback", () => {
  it("returns 200 with logs from xcodeBuildLogsUrl when logFileUrls is empty", async () => {
    const xcodeLog = "xcode build started\nbuild succeeded";

    mockFetch
      .mockResolvedValueOnce(
        gqlBuildResponse({
          id:          BUILD_ID,
          status:      "FINISHED",
          platform:    "IOS",
          createdAt:   "2026-08-22T09:00:00Z",
          logFileUrls: [],
          artifacts:   {
            buildUrl:          "https://cdn.example.com/app.ipa",
            xcodeBuildLogsUrl: "https://s3.example.com/xcode.log",
          },
        }),
      )
      .mockResolvedValueOnce(textResponse(xcodeLog));

    const res = await request(app)
      .get(`/api/eas/builds/${BUILD_ID}/logs`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual(["xcode build started", "build succeeded"]);
  });
});

// ── EAS GraphQL failure ───────────────────────────────────────────────────────

describe("GET /api/eas/builds/:buildId/logs — GraphQL failure", () => {
  it("returns 502 when EAS GraphQL returns a non-ok HTTP response", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500));

    const res = await request(app)
      .get(`/api/eas/builds/${BUILD_ID}/logs`)
      .set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 502 when GraphQL returns a top-level errors array (build not found)", async () => {
    mockFetch.mockResolvedValueOnce(gqlErrorResponse("Build not found"));

    const res = await request(app)
      .get(`/api/eas/builds/${BUILD_ID}/logs`)
      .set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/build not found/i);
  });

  it("returns 503 when EAS_CLOWNIN_KEY is not configured", async () => {
    delete process.env["EAS_CLOWNIN_KEY"];

    const res = await request(app)
      .get(`/api/eas/builds/${BUILD_ID}/logs`)
      .set(AUTH);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });
});
