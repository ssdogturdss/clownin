/**
 * Admin API routes — protected by requireAdmin middleware.
 *
 * Admin users are identified by their userId appearing in the
 * ADMIN_USER_IDS environment variable (comma-separated integers).
 * Example: ADMIN_USER_IDS=1,2
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, usersTable, projectsTable, projectFilesTable, projectEnvVarsTable, conversationMessagesTable, promoCodesTable, providerConfigsTable } from "@workspace/db";
import { eq, desc, count, sql, and } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { randomBytes } from "crypto";
import { z } from "zod";

const router: IRouter = Router();

// ── requireAdmin middleware ────────────────────────────────────────────────────

function getAdminUserIds(): Set<number> {
  const raw = process.env.ADMIN_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n)),
  );
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const adminIds = getAdminUserIds();
  if (adminIds.size === 0) {
    res.status(503).json({ error: "Admin access is not configured. Set ADMIN_USER_IDS." });
    return;
  }
  const { userId } = getUser(req);
  if (!adminIds.has(userId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

// ── Stats ─────────────────────────────────────────────────────────────────────

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

// ── AI Provider config ────────────────────────────────────────────────────────

const KNOWN_PROVIDERS = [
  { provider: "openai",     displayName: "OpenAI" },
  { provider: "anthropic",  displayName: "Anthropic" },
  { provider: "gemini",     displayName: "Google Gemini" },
  { provider: "openrouter", displayName: "OpenRouter" },
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
  const { apiKey, isActive, clearKey } = req.body as {
    apiKey?: string;
    isActive?: boolean;
    clearKey?: boolean;
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
    await db.update(providerConfigsTable).set(set).where(eq(providerConfigsTable.provider, providerKey));
  } else {
    const vals: typeof providerConfigsTable.$inferInsert = {
      provider: providerKey,
      displayName: knownProvider.displayName,
      isActive: isActive ?? false,
      updatedAt: now,
    };
    if (typeof apiKey === "string" && apiKey.trim()) vals.encryptedApiKey = encrypt(apiKey.trim());
    await db.insert(providerConfigsTable).values(vals);
  }

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
    updatedAt: row!.updatedAt,
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
