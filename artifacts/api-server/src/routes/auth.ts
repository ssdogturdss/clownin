import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signToken, requireAuth, getUser } from "../lib/auth";

const router: IRouter = Router();

const FREE_DAILY_LIMIT = 20;

router.post("/auth/register", async (req, res): Promise<void> => {
  const { username, email, password } = req.body ?? {};

  if (!username || !email || !password) {
    res.status(400).json({ error: "username, email, and password are required" });
    return;
  }
  if (username.length < 3) {
    res.status(400).json({ error: "username must be at least 3 characters" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "password must be at least 6 characters" });
    return;
  }

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (existing.length > 0) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const existingUsername = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  if (existingUsername.length > 0) {
    res.status(409).json({ error: "Username already taken" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(usersTable)
    .values({ username, email, passwordHash })
    .returning();

  const token = signToken({ userId: user.id, email: user.email, username: user.username });

  req.log.info({ userId: user.id }, "User registered");
  // New users always start on the free tier with no messages sent today.
  res.status(201).json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      createdAt: user.createdAt,
      subscriptionTier: user.subscriptionTier,
      dailyMessageCount: 0,
      dailyMessageLimit: FREE_DAILY_LIMIT,
    },
  });
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = signToken({ userId: user.id, email: user.email, username: user.username });

  // Compute effective daily count — reset to 0 if it's a new day.
  const todayStr = new Date().toISOString().slice(0, 10);
  const effectiveDailyCount =
    user.lastMessageDate === todayStr ? user.dailyMessageCount : 0;

  req.log.info({ userId: user.id }, "User logged in");
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      createdAt: user.createdAt,
      subscriptionTier: user.subscriptionTier,
      dailyMessageCount: effectiveDailyCount,
      dailyMessageLimit: user.subscriptionTier === "free" ? FREE_DAILY_LIMIT : null,
    },
  });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Compute effective daily count — reset if it's a new day
  const todayStr = new Date().toISOString().slice(0, 10);
  const effectiveDailyCount =
    user.lastMessageDate === todayStr ? user.dailyMessageCount : 0;

  res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    createdAt: user.createdAt,
    subscriptionTier: user.subscriptionTier,
    dailyMessageCount: effectiveDailyCount,
    dailyMessageLimit: user.subscriptionTier === "free" ? FREE_DAILY_LIMIT : null,
  });
});

// NOTE: Subscription tier updates are NOT exposed as a client-callable endpoint.
// Tier changes must originate from a trusted server-side billing event
// (e.g. a RevenueCat webhook verified with a shared secret). A client-callable
// PATCH would let any authenticated user self-promote to Pro for free.

export default router;
