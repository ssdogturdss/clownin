/**
 * RevenueCat webhook handler.
 *
 * RevenueCat sends a POST with:
 *   Authorization: <webhook_secret>   (plain string, not "Bearer …")
 *   Content-Type: application/json
 *
 * The `event.app_user_id` field is set to the numeric user ID (string) that
 * the mobile client passes to `Purchases.logIn(String(user.id))` at login.
 *
 * Webhook URL to register in the RevenueCat dashboard:
 *   https://<your-domain>/webhooks/revenuecat
 *
 * Set the REVENUECAT_WEBHOOK_SECRET environment variable to the shared secret
 * configured in the RevenueCat dashboard.
 */
import { Router } from "express";
import express from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

/** Event types that indicate an active, paid subscription. */
const UPGRADE_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "PRODUCT_CHANGE",
]);

/** Event types that indicate a subscription has ended or been cancelled. */
const DOWNGRADE_EVENTS = new Set(["CANCELLATION", "EXPIRATION"]);

router.post(
  "/webhooks/revenuecat",
  // Parse the raw body here so we can verify the Authorization header before
  // the global express.json() middleware consumes the stream.
  express.raw({ type: "application/json" }),
  async (req, res): Promise<void> => {
    // ── 1. Verify shared secret ────────────────────────────────────────────
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    if (!secret) {
      req.log.error("REVENUECAT_WEBHOOK_SECRET is not set");
      res.status(500).json({ error: "Webhook not configured" });
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    if (authHeader !== secret) {
      req.log.warn({ authHeader: authHeader.slice(0, 8) + "…" }, "Invalid RevenueCat webhook secret");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // ── 2. Parse body ──────────────────────────────────────────────────────
    let body: unknown;
    try {
      body = JSON.parse((req.body as Buffer).toString("utf-8"));
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }

    const event = (body as Record<string, unknown>)?.event as Record<string, unknown> | undefined;
    if (!event) {
      res.status(400).json({ error: "Missing event object" });
      return;
    }

    const eventType = event.type as string | undefined;
    // `app_user_id` is set to String(user.id) via Purchases.logIn() in the app.
    // Fall back to original_app_user_id in case of alias events.
    const appUserId =
      (event.app_user_id as string | undefined) ??
      (event.original_app_user_id as string | undefined);

    if (!appUserId) {
      req.log.warn({ eventType }, "RC event missing app_user_id — ignoring");
      res.status(200).json({ received: true });
      return;
    }

    const userId = parseInt(appUserId, 10);
    if (isNaN(userId)) {
      // Anonymous RC user (e.g. "$RCAnonymousID:…") — nothing to map
      req.log.debug({ eventType, appUserId }, "Skipping anonymous RC user");
      res.status(200).json({ received: true });
      return;
    }

    // ── 3. Apply subscription change ───────────────────────────────────────
    if (eventType && UPGRADE_EVENTS.has(eventType)) {
      await db
        .update(usersTable)
        .set({ subscriptionTier: "pro" })
        .where(eq(usersTable.id, userId));
      req.log.info({ userId, eventType }, "RevenueCat: upgraded user to pro");
    } else if (eventType && DOWNGRADE_EVENTS.has(eventType)) {
      await db
        .update(usersTable)
        .set({ subscriptionTier: "free" })
        .where(eq(usersTable.id, userId));
      req.log.info({ userId, eventType }, "RevenueCat: reverted user to free");
    } else {
      req.log.debug({ eventType }, "RevenueCat: ignoring event type");
    }

    res.status(200).json({ received: true });
  },
);

export default router;
