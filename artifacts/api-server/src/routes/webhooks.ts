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
 * Secret rotation (zero-downtime)
 * ────────────────────────────────
 * Two environment variables are accepted simultaneously so you can rotate the
 * secret without a gap in coverage:
 *
 *   REVENUECAT_WEBHOOK_SECRET       – the current (new) secret
 *   REVENUECAT_WEBHOOK_SECRET_PREV  – the previous secret (optional, cleared
 *                                     after RevenueCat is updated)
 *
 * See /docs/webhook-rotation-runbook.md for the full rotation procedure.
 *
 * Abuse monitoring
 * ────────────────
 * An in-memory sliding-window counter tracks upgrade and downgrade events over
 * the last hour. When the upgrade count is unusually high relative to
 * downgrades (≥ SPIKE_MIN_UPGRADES upgrades AND ratio ≥ SPIKE_RATIO_THRESHOLD)
 * the handler logs a "warn" line so on-call alerts can fire on it.
 */
import { Router } from "express";
import express from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

// ── Constants ──────────────────────────────────────────────────────────────

/** Event types that indicate an active, paid subscription. */
const UPGRADE_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "PRODUCT_CHANGE",
]);

/** Event types that indicate a subscription has ended or been cancelled. */
const DOWNGRADE_EVENTS = new Set(["CANCELLATION", "EXPIRATION"]);

// ── Spike detection ────────────────────────────────────────────────────────

/** Sliding-window length in milliseconds (1 hour). */
const WINDOW_MS = 60 * 60 * 1_000;

/** Minimum upgrade count before the ratio check is applied. */
const SPIKE_MIN_UPGRADES = 10;

/**
 * If upgrades / max(1, downgrades) ≥ this threshold the handler logs a
 * warning.  A ratio of 10 means 10× more upgrades than downgrades in the
 * window, which is a strong signal of abuse (real traffic is roughly balanced
 * over time).
 */
const SPIKE_RATIO_THRESHOLD = 10;

/**
 * Maximum timestamps retained in each array regardless of window size.
 * Caps memory consumption so a sustained flood of forged events cannot
 * exhaust process heap.  Once the cap is reached, older in-window events
 * are already sufficient to keep the ratio accurate; new arrivals are still
 * recorded by replacing the oldest entry via a circular approach (shift +
 * push) rather than growing the array.
 */
const MAX_SPIKE_ENTRIES = 500;

/**
 * Minimum milliseconds between consecutive spike-alert emissions.
 * Prevents log-volume exhaustion: after a threshold breach is detected the
 * next warning fires at most once per 5-minute cooldown window.
 */
const ALERT_COOLDOWN_MS = 5 * 60 * 1_000;

export interface SpikeCounter {
  upgrades: number[];   // epoch-ms timestamps (capped at MAX_SPIKE_ENTRIES)
  downgrades: number[]; // epoch-ms timestamps (capped at MAX_SPIKE_ENTRIES)
  lastAlertAt: number;  // epoch-ms of the most recent alert emission
}

/** Module-level counter shared across requests (reset on process restart). */
export const _spikeCounter: SpikeCounter = {
  upgrades: [],
  downgrades: [],
  lastAlertAt: 0,
};

/** Prune timestamps older than WINDOW_MS from both arrays. */
function pruneWindow(counter: SpikeCounter, now: number): void {
  const cutoff = now - WINDOW_MS;
  counter.upgrades   = counter.upgrades.filter((t) => t > cutoff);
  counter.downgrades = counter.downgrades.filter((t) => t > cutoff);
}

/**
 * Add a timestamp to the array, keeping its length ≤ MAX_SPIKE_ENTRIES.
 * When the cap is reached the oldest entry is evicted (shift + push) so
 * memory is bounded regardless of how many events arrive.
 */
function appendBounded(arr: number[], ts: number): void {
  if (arr.length >= MAX_SPIKE_ENTRIES) {
    arr.shift();
  }
  arr.push(ts);
}

/**
 * Record an event and return `true` when an anomalous spike is detected
 * AND enough time has passed since the last alert (rate-limited).
 *
 * Properties:
 * - Each array is capped at MAX_SPIKE_ENTRIES entries → bounded memory.
 * - Alerts fire at most once per ALERT_COOLDOWN_MS → bounded log volume.
 *
 * Exported for testing.
 */
export function recordAndCheckSpike(
  kind: "upgrade" | "downgrade",
  counter: SpikeCounter = _spikeCounter,
  now: number = Date.now(),
): boolean {
  if (kind === "upgrade") {
    appendBounded(counter.upgrades, now);
  } else {
    appendBounded(counter.downgrades, now);
  }

  pruneWindow(counter, now);

  const ups   = counter.upgrades.length;
  const downs = counter.downgrades.length;

  if (ups < SPIKE_MIN_UPGRADES) return false;

  const ratio = ups / Math.max(1, downs);
  if (ratio < SPIKE_RATIO_THRESHOLD) return false;

  // Rate-limit: suppress repeated alerts within the cooldown window so a
  // sustained flood of forged requests cannot exhaust log storage.
  if (now - counter.lastAlertAt < ALERT_COOLDOWN_MS) return false;

  counter.lastAlertAt = now;
  return true;
}

// ── Secret verification ────────────────────────────────────────────────────

/**
 * Return `true` when the Authorization header matches at least one of the
 * configured secrets (primary or previous, for zero-downtime rotation).
 */
export function isValidSecret(authHeader: string): boolean {
  const primary  = process.env.REVENUECAT_WEBHOOK_SECRET ?? "";
  const previous = process.env.REVENUECAT_WEBHOOK_SECRET_PREV ?? "";

  if (!primary) return false; // misconfigured — reject everything

  if (authHeader === primary) return true;
  if (previous && authHeader === previous) return true;
  return false;
}

// ── Route ──────────────────────────────────────────────────────────────────

router.post(
  "/webhooks/revenuecat",
  // Parse the raw body here so we can verify the Authorization header before
  // the global express.json() middleware consumes the stream.
  express.raw({ type: "application/json" }),
  async (req, res): Promise<void> => {
    // ── 1. Verify shared secret ──────────────────────────────────────────
    if (!process.env.REVENUECAT_WEBHOOK_SECRET) {
      req.log.error("REVENUECAT_WEBHOOK_SECRET is not set");
      res.status(500).json({ error: "Webhook not configured" });
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    if (!isValidSecret(authHeader)) {
      req.log.warn(
        { authHeader: authHeader.slice(0, 8) + "…" },
        "Invalid RevenueCat webhook secret",
      );
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Log when the previous (rotating-out) secret is still in use so ops know
    // when it is safe to remove REVENUECAT_WEBHOOK_SECRET_PREV.
    const previous = process.env.REVENUECAT_WEBHOOK_SECRET_PREV ?? "";
    if (previous && authHeader === previous) {
      req.log.warn(
        "RevenueCat webhook authenticated with the PREVIOUS secret — " +
        "update the secret in the RevenueCat dashboard and remove " +
        "REVENUECAT_WEBHOOK_SECRET_PREV once done",
      );
    }

    // ── 2. Parse body ────────────────────────────────────────────────────
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

    // ── 3. Apply subscription change ─────────────────────────────────────
    if (eventType && UPGRADE_EVENTS.has(eventType)) {
      await db
        .update(usersTable)
        .set({ subscriptionTier: "pro" })
        .where(eq(usersTable.id, userId));
      req.log.info({ userId, eventType }, "RevenueCat: upgraded user to pro");

      // Spike detection — warn if the upgrade rate looks anomalous.
      if (recordAndCheckSpike("upgrade")) {
        req.log.warn(
          {
            upgradesInWindow: _spikeCounter.upgrades.length,
            downgradesInWindow: _spikeCounter.downgrades.length,
          },
          "ALERT: Abnormal upgrade spike detected in the last hour — " +
          "possible webhook secret abuse. Rotate REVENUECAT_WEBHOOK_SECRET " +
          "immediately and audit recent subscription upgrades.",
        );
      }
    } else if (eventType && DOWNGRADE_EVENTS.has(eventType)) {
      await db
        .update(usersTable)
        .set({ subscriptionTier: "free" })
        .where(eq(usersTable.id, userId));
      req.log.info({ userId, eventType }, "RevenueCat: reverted user to free");

      recordAndCheckSpike("downgrade");
    } else {
      req.log.debug({ eventType }, "RevenueCat: ignoring event type");
    }

    res.status(200).json({ received: true });
  },
);

export default router;
