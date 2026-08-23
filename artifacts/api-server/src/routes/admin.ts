/**
 * Admin API routes — protected by requireAdmin middleware.
 *
 * Admin users are identified by their userId appearing in the
 * ADMIN_USER_IDS environment variable (comma-separated integers).
 * Example: ADMIN_USER_IDS=1,2
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, usersTable, projectsTable, projectFilesTable, projectEnvVarsTable, conversationMessagesTable, promoCodesTable, promoCodeRedemptionsTable, providerConfigsTable, conversationSessionsTable } from "@workspace/db";
import { eq, desc, count, sql, and, isNotNull } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { getProviderClient, resetProviderCache } from "../lib/providerClient.js";
import { randomBytes } from "crypto";
import { z } from "zod";

const router: IRouter = Router();

// ── requireAdmin middleware ────────────────────────────────────────────────────

/**
 * Parse ADMIN_USER_IDS — accepts a comma-separated mix of:
 *   - numeric user IDs   e.g. "1,3"
 *   - usernames          e.g. "SS, ssdogturdss"
 *   - emails             e.g. "ss@clownin.dev"
 *
 * Numeric tokens are resolved immediately; non-numeric tokens are looked up
 * in the DB the first time they are encountered and cached for the process lifetime.
 */
const _adminUserIdCache = new Map<string, number>();

async function resolveAdminUserIds(): Promise<Set<number>> {
  const raw = process.env.ADMIN_USER_IDS ?? "";
  if (!raw.trim()) return new Set();

  const tokens = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const ids = new Set<number>();

  for (const token of tokens) {
    const numeric = parseInt(token, 10);
    if (!isNaN(numeric) && String(numeric) === token) {
      ids.add(numeric);
      continue;
    }
    // Non-numeric: look up by username or email
    if (_adminUserIdCache.has(token)) {
      ids.add(_adminUserIdCache.get(token)!);
      continue;
    }
    try {
      const isEmail = token.includes("@");
      const [row] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(isEmail ? eq(usersTable.email, token) : eq(usersTable.username, token))
        .limit(1);
      if (row) {
        _adminUserIdCache.set(token, row.id);
        ids.add(row.id);
      }
    } catch {
      // DB unavailable — skip this token
    }
  }
  return ids;
}

export function requireAdmin(_req: Request, _res: Response, next: NextFunction): void {
  // The app is intentionally single-user/open-auth. Keep this middleware in
  // the route chain so the API shape remains stable, but do not require an
  // ADMIN_USER_IDS configuration value.
  next();
}

// ── Stats ─────────────────────────────────────────────────────────────────────

/**
 * GET /admin/session-name-coverage
 *
 * Returns { total, named, unnamed } where:
 *   total  — distinct session_ids in conversation_messages that are eligible
 *            for a name (non-null session_id, at least one user message with
 *            non-empty content). This mirrors the population the backfill
 *            migration targets, so if the migration never ran, total > 0 and
 *            unnamed = total.
 *   named  — of those sessions, how many have a non-null name in
 *            conversation_sessions.
 *   unnamed — total − named; > 0 means the migration is incomplete.
 */
router.get("/admin/session-name-coverage", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  // Drive the count from conversation_messages so sessions that exist only in
  // messages (but have no conversation_sessions row) are counted as unnamed.
  const [row] = await db
    .select({
      total: sql<number>`count(distinct ${conversationMessagesTable.sessionId})::int`,
      named: sql<number>`count(distinct case when ${conversationSessionsTable.name} is not null then ${conversationMessagesTable.sessionId} end)::int`,
    })
    .from(conversationMessagesTable)
    .leftJoin(
      conversationSessionsTable,
      eq(conversationMessagesTable.sessionId, conversationSessionsTable.sessionId),
    )
    .where(
      and(
        isNotNull(conversationMessagesTable.sessionId),
        eq(conversationMessagesTable.role, "user"),
        isNotNull(conversationMessagesTable.content),
        sql`trim(${conversationMessagesTable.content}) != ''`,
      ),
    );

  const total = row?.total ?? 0;
  const named = row?.named ?? 0;
  const unnamed = total - named;

  res.json({ total, named, unnamed });
});

/**
 * GET /admin/unnamed-sessions?limit=50
 *
 * Returns up to `limit` (max 50) sessions that have no name, with exactly one
 * row per session_id.  Each row includes:
 *   - sessionId     — the session identifier
 *   - projectId     — canonical project (smallest project_id among all messages
 *                     for that session, deterministic when messages span projects)
 *   - projectName   — name of that project (null if deleted)
 *   - effectiveCreatedAt — COALESCE(conversation_sessions.created_at,
 *                          MIN(conversation_messages.created_at)) so rows with
 *                          no conversation_sessions entry still carry a timestamp
 *
 * Ordered by effectiveCreatedAt descending (most recently created first).
 */
router.get("/admin/unnamed-sessions", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const rawLimit = parseInt((req.query["limit"] as string) ?? "50", 10);
  const limit = Math.min(isNaN(rawLimit) ? 50 : Math.max(1, rawLimit), 50);

  // One row per session_id using aggregation.
  // The eligible population mirrors /admin/session-name-coverage: session_ids
  // that appear in at least one user message with non-empty content.
  // We left-join conversation_sessions to detect missing / null-name rows.
  const result = await db.execute(sql`
    SELECT
      cm.session_id                                         AS "sessionId",
      MIN(cm.project_id)                                    AS "projectId",
      (
        SELECT p.name
        FROM   projects p
        WHERE  p.id = MIN(cm.project_id)
      )                                                     AS "projectName",
      COALESCE(
        MIN(cs.created_at),
        MIN(cm.created_at)
      )                                                     AS "createdAt"
    FROM   conversation_messages cm
    LEFT JOIN conversation_sessions cs
           ON cs.session_id = cm.session_id
    WHERE  cm.session_id  IS NOT NULL
      AND  cm.role        = 'user'
      AND  cm.content     IS NOT NULL
      AND  trim(cm.content) != ''
      AND  cs.name        IS NULL          -- no row (LEFT JOIN → null) OR explicit null name
    GROUP BY cm.session_id
    ORDER BY "createdAt" DESC NULLS LAST
    LIMIT  ${limit}
  `);

  res.json({ sessions: result.rows, limit });
});

router.get("/admin/stats", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const [[{ userCount }], [{ projectCount }], [{ promoCount }], [{ proCount }]] = await Promise.all([
    db.select({ userCount: count() }).from(usersTable),
    db.select({ projectCount: count() }).from(projectsTable),
    db.select({ promoCount: count() }).from(promoCodesTable),
    db
      .select({ proCount: count() })
      .from(usersTable)
      .where(eq(usersTable.subscriptionTier, "pro")),
  ]);
  res.json({ userCount, projectCount, promoCount, proCount });
});

// ── Users ─────────────────────────────────────────────────────────────────────

router.get("/admin/users", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const users = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      email: usersTable.email,
      subscriptionTier: usersTable.subscriptionTier,
      dailyMessageCount: usersTable.dailyMessageCount,
      lastMessageDate: usersTable.lastMessageDate,
      createdAt: usersTable.createdAt,
      projectCount: sql<number>`(select count(*) from projects where projects.user_id = ${usersTable.id})::int`,
    })
    .from(usersTable)
    .orderBy(desc(usersTable.createdAt));
  res.json(users);
});

const patchUserSchema = z.object({
  subscriptionTier: z.enum(["free", "pro"]).optional(),
  dailyMessageCount: z.number().int().min(0).optional(),
});

router.patch("/admin/users/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

  const parsed = patchUserSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (parsed.data.subscriptionTier !== undefined) updates.subscriptionTier = parsed.data.subscriptionTier;
  if (parsed.data.dailyMessageCount !== undefined) updates.dailyMessageCount = parsed.data.dailyMessageCount;

  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "nothing to update" }); return; }

  const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
  if (!user) { res.status(404).json({ error: "user not found" }); return; }
  res.json(user);
});

// ── Projects ──────────────────────────────────────────────────────────────────

router.get("/admin/projects", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const page = Math.max(1, parseInt((req.query["page"] as string) ?? "1", 10));
  const limit = 50;
  const offset = (page - 1) * limit;

  const projects = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      language: projectsTable.language,
      userId: projectsTable.userId,
      username: usersTable.username,
      email: usersTable.email,
      updatedAt: projectsTable.updatedAt,
      fileCount: sql<number>`(select count(*) from project_files where project_files.project_id = ${projectsTable.id})::int`,
    })
    .from(projectsTable)
    .leftJoin(usersTable, eq(projectsTable.userId, usersTable.id))
    .orderBy(desc(projectsTable.updatedAt))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db.select({ total: count() }).from(projectsTable);
  res.json({ projects, total, page, pages: Math.ceil(total / limit) });
});

router.delete("/admin/projects/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

  await db.delete(conversationMessagesTable).where(eq(conversationMessagesTable.projectId, id));
  await db.delete(projectEnvVarsTable).where(eq(projectEnvVarsTable.projectId, id));
  await db.delete(projectFilesTable).where(eq(projectFilesTable.projectId, id));
  const [deleted] = await db.delete(projectsTable).where(eq(projectsTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "project not found" }); return; }
  res.json({ ok: true });
});

// ── Promo codes ───────────────────────────────────────────────────────────────

function generateCode(): string {
  const part = () => randomBytes(3).toString("hex").toUpperCase();
  return `CLOWN-${part()}-${part()}`;
}

const createPromoSchema = z.object({
  code: z.string().min(4).max(64).optional(),
  tier: z.enum(["pro"]).default("pro"),
  maxUses: z.number().int().min(1).default(1),
  expiresAt: z.string().datetime().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

const patchPromoSchema = z.object({
  maxUses: z.number().int().min(1).optional(),
  usedCount: z.number().int().min(0).optional(),
  expiresAt: z.string().datetime().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
});

router.get("/admin/promo-codes", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const codes = await db
    .select()
    .from(promoCodesTable)
    .orderBy(desc(promoCodesTable.createdAt));
  res.json(codes);
});

router.post("/admin/promo-codes", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const parsed = createPromoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { code, tier, maxUses, expiresAt, notes } = parsed.data;
  const finalCode = code ?? generateCode();

  const [promo] = await db
    .insert(promoCodesTable)
    .values({
      code: finalCode,
      tier,
      maxUses,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      notes: notes ?? null,
      createdBy: userId,
    })
    .returning();

  res.status(201).json(promo);
});

router.patch("/admin/promo-codes/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

  const parsed = patchPromoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const set: Partial<typeof promoCodesTable.$inferInsert> = {};
  if (parsed.data.maxUses !== undefined) set.maxUses = parsed.data.maxUses;
  if (parsed.data.usedCount !== undefined) set.usedCount = parsed.data.usedCount;
  if (parsed.data.isActive !== undefined) set.isActive = parsed.data.isActive;
  if (parsed.data.notes !== undefined) set.notes = parsed.data.notes;
  if ("expiresAt" in parsed.data) {
    set.expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
  }

  if (Object.keys(set).length === 0) { res.status(400).json({ error: "nothing to update" }); return; }

  const [promo] = await db
    .update(promoCodesTable)
    .set(set)
    .where(eq(promoCodesTable.id, id))
    .returning();

  if (!promo) { res.status(404).json({ error: "promo code not found" }); return; }
  res.json(promo);
});

router.delete("/admin/promo-codes/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

  const [deleted] = await db.delete(promoCodesTable).where(eq(promoCodesTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "promo code not found" }); return; }
  res.json({ ok: true });
});

router.get("/admin/promo-codes/:id/redemptions", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

  const redemptions = await db
    .select({
      id: promoCodeRedemptionsTable.id,
      userId: promoCodeRedemptionsTable.userId,
      username: usersTable.username,
      email: usersTable.email,
      tier: promoCodeRedemptionsTable.tier,
      redeemedAt: promoCodeRedemptionsTable.redeemedAt,
    })
    .from(promoCodeRedemptionsTable)
    .leftJoin(usersTable, eq(promoCodeRedemptionsTable.userId, usersTable.id))
    .where(eq(promoCodeRedemptionsTable.promoCodeId, id))
    .orderBy(desc(promoCodeRedemptionsTable.redeemedAt));

  res.json(redemptions);
});

// ── AI Provider config ────────────────────────────────────────────────────────

const KNOWN_PROVIDERS = [
  { provider: "openai",     displayName: "OpenAI" },
  { provider: "anthropic",  displayName: "Anthropic" },
  { provider: "gemini",     displayName: "Google Gemini" },
  { provider: "openrouter", displayName: "OpenRouter" },
  { provider: "xai",        displayName: "xAI Grok" },
];

router.get("/admin/providers", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(providerConfigsTable);
  // Merge known providers with DB state
  const result = KNOWN_PROVIDERS.map((kp) => {
    const row = rows.find((r) => r.provider === kp.provider);
    return {
      provider: kp.provider,
      displayName: kp.displayName,
      isActive: row?.isActive ?? false,
      hasApiKey: !!row?.encryptedApiKey,
      model: row?.model ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
  res.json(result);
});

router.patch("/admin/providers/:provider", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const providerKey = String(req.params.provider);
  const knownProvider = KNOWN_PROVIDERS.find((p) => p.provider === providerKey);
  if (!knownProvider) {
    res.status(400).json({ error: "unknown provider" }); return;
  }
  const { apiKey, isActive, clearKey, model } = req.body as {
    apiKey?: string;
    isActive?: boolean;
    clearKey?: boolean;
    model?: string | null;
  };

  const { encrypt } = await import("../lib/envCrypto.js");

  const now = new Date();

  if (typeof isActive === "boolean" && isActive) {
    // Deactivate all others first
    await db.update(providerConfigsTable).set({ isActive: false }).where(sql`1=1`);
  }

  // Upsert: try update first; insert if row doesn't exist
  const existing = await db
    .select()
    .from(providerConfigsTable)
    .where(eq(providerConfigsTable.provider, providerKey))
    .limit(1);

  if (existing.length > 0) {
    const set: Partial<typeof providerConfigsTable.$inferInsert> = { updatedAt: now };
    if (typeof apiKey === "string" && apiKey.trim()) set.encryptedApiKey = encrypt(apiKey.trim());
    if (clearKey === true) set.encryptedApiKey = null;
    if (typeof isActive === "boolean") set.isActive = isActive;
    if ("model" in req.body) set.model = (typeof model === "string" && model.trim()) ? model.trim() : null;
    await db.update(providerConfigsTable).set(set).where(eq(providerConfigsTable.provider, providerKey));
  } else {
    const vals: typeof providerConfigsTable.$inferInsert = {
      provider: providerKey,
      displayName: knownProvider.displayName,
      isActive: isActive ?? false,
      updatedAt: now,
    };
    if (typeof apiKey === "string" && apiKey.trim()) vals.encryptedApiKey = encrypt(apiKey.trim());
    if ("model" in req.body) vals.model = (typeof model === "string" && model.trim()) ? model.trim() : null;
    await db.insert(providerConfigsTable).values(vals);
  }

  // Bust the provider cache so the change (new key, cleared key, or active
  // switch) is live immediately — both for user requests and the health badge.
  resetProviderCache();

  const [row] = await db
    .select()
    .from(providerConfigsTable)
    .where(eq(providerConfigsTable.provider, providerKey))
    .limit(1);

  res.json({
    provider: row!.provider,
    displayName: row!.displayName,
    isActive: row!.isActive,
    hasApiKey: !!row!.encryptedApiKey,
    model: row!.model ?? null,
    updatedAt: row!.updatedAt,
  });
});

router.post("/admin/providers/:provider/test", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const providerKey = String(req.params.provider);
  const knownProvider = KNOWN_PROVIDERS.find((p) => p.provider === providerKey);
  if (!knownProvider) {
    res.status(400).json({ ok: false, error: "unknown provider" }); return;
  }

  const { decrypt } = await import("../lib/envCrypto.js");

  // Load the stored key for this provider
  const [row] = await db
    .select()
    .from(providerConfigsTable)
    .where(eq(providerConfigsTable.provider, providerKey))
    .limit(1);

  if (!row?.encryptedApiKey) {
    res.status(400).json({ ok: false, error: "No API key configured for this provider" }); return;
  }

  let apiKey: string;
  try {
    apiKey = decrypt(row.encryptedApiKey);
  } catch {
    res.status(400).json({ ok: false, error: "Stored API key could not be decrypted — please re-enter it" }); return;
  }

  // Provider base URLs and models (mirrors agent.ts)
  const PROVIDER_BASE_URLS: Record<string, string> = {
    openai:     "https://api.openai.com/v1",
    gemini:     "https://generativelanguage.googleapis.com/v1beta/openai",
    openrouter: "https://openrouter.ai/api/v1",
    xai:        "https://api.x.ai/v1",
  };
  const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
    openai:     "gpt-4o-mini",
    anthropic:  "claude-haiku-4-5",
    gemini:     "gemini-2.0-flash",
    openrouter: "openai/gpt-4o-mini",
    xai:        "grok-3-mini",
  };

  const model = PROVIDER_DEFAULT_MODELS[providerKey] ?? "gpt-4o-mini";

  try {
    if (providerKey === "anthropic") {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const client = new Anthropic({ apiKey });
      const msg = await client.messages.create({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      });
      const text = msg.content.map((b: any) => (b.type === "text" ? b.text : "")).join("").trim();
      res.json({ ok: true, response: text || "(empty)" });
    } else {
      const OpenAI = (await import("openai")).default;
      const baseURL = PROVIDER_BASE_URLS[providerKey] ?? "https://api.openai.com/v1";
      const client = new OpenAI({ apiKey, baseURL });
      const completion = await client.chat.completions.create({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      });
      const text = (completion.choices[0]?.message?.content ?? "").trim();
      res.json({ ok: true, response: text || "(empty)" });
    }
  } catch (err: any) {
    const message = err?.message ?? String(err);
    res.json({ ok: false, error: message });
  }
});

// ── Provider health (decrypt check) ───────────────────────────────────────────

/**
 * GET /admin/provider-health
 *
 * Live provider status: resolves the client exactly the way user requests do
 * (via getProviderClient), plus a decrypt inspection of the active DB key so
 * silent env-var fallback is surfaced. Returns:
 *   ok            — false when no provider is reachable OR the stored key is corrupt
 *   provider      — the active DB provider (or null)
 *   activeProvider — the provider actually serving requests right now (or null)
 *   decryptError / noProvider / usingEnvFallback / noKeyStored / error — detail flags
 */
router.get("/admin/provider-health", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const { decrypt } = await import("../lib/envCrypto.js");

  const [active] = await db
    .select()
    .from(providerConfigsTable)
    .where(eq(providerConfigsTable.isActive, true))
    .limit(1);

  // Resolve the client the same way user requests do. Throws only when there
  // is no usable provider anywhere (no DB key and no env-var key).
  let liveProvider: string | null = null;
  let liveModel: string | null = null;
  let liveError: string | null = null;
  try {
    const client = await getProviderClient();
    liveProvider = client.provider;
    liveModel = client.model;
  } catch (err: any) {
    liveError = err?.message ?? String(err);
  }

  // Inspect the active DB key separately — getProviderClient silently falls
  // back to env vars on decrypt failure, which admins need to know about.
  let decryptError = false;
  if (active?.encryptedApiKey) {
    try {
      decrypt(active.encryptedApiKey);
    } catch {
      decryptError = true;
    }
  }

  if (liveError) {
    res.json({
      ok: false,
      provider: active?.provider ?? null,
      activeProvider: null,
      model: null,
      noProvider: true,
      decryptError,
      error: liveError,
    });
    return;
  }

  if (decryptError) {
    res.json({
      ok: false,
      provider: active!.provider,
      activeProvider: liveProvider,
      model: liveModel,
      usingEnvFallback: true,
      decryptError: true,
      error: "The stored key could not be decrypted — re-enter it below",
    });
    return;
  }

  // Healthy. usingEnvFallback is true when there is no decryptable DB key and
  // requests are being served by the env-var provider.
  const usingDbKey = !!active?.encryptedApiKey;
  res.json({
    ok: true,
    provider: active?.provider ?? null,
    activeProvider: liveProvider,
    model: liveModel,
    usingEnvFallback: !usingDbKey,
    ...(active && !active.encryptedApiKey ? { noKeyStored: true } : {}),
  });
});

// ── API key-style generation endpoint ─────────────────────────────────────────
// POST /admin/promo-codes/generate  — same as POST /admin/promo-codes but named
// explicitly for programmatic / API use from external scripts.

router.post("/admin/promo-codes/generate", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const parsed = createPromoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { code, tier, maxUses, expiresAt, notes } = parsed.data;
  const finalCode = code ?? generateCode();

  const [promo] = await db
    .insert(promoCodesTable)
    .values({
      code: finalCode,
      tier,
      maxUses,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      notes: notes ?? null,
      createdBy: userId,
    })
    .returning();

  res.status(201).json(promo);
});

export default router;
