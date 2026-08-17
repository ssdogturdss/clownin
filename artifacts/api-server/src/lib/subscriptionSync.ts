/**
 * Daily subscription sync job.
 *
 * Runs once per day (at 03:00 server time) and verifies every user whose
 * subscriptionTier is 'pro' still has an active entitlement in RevenueCat.
 * If RevenueCat says the entitlement is gone or expired the user is reverted
 * to 'free' so stale state from a missed/failed webhook delivery is healed.
 *
 * Required environment variable:
 *   REVENUECAT_API_KEY — the RevenueCat secret (or public) API key used to
 *                        call the REST API on behalf of the server.
 *
 * The entitlement identifier that grants Pro access is read from:
 *   REVENUECAT_PRO_ENTITLEMENT_ID (default: "pro")
 */

import cron from "node-cron";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const RC_API_BASE = "https://api.revenuecat.com/v1";

/**
 * Check whether a given RC app_user_id (= String(user.id)) has an active
 * Pro entitlement right now according to the RevenueCat REST API.
 *
 * Returns `true` if the entitlement is active, `false` otherwise.
 * Throws on network / auth errors so the caller can decide whether to skip.
 */
async function hasActiveProEntitlement(
  appUserId: string,
  apiKey: string,
  entitlementId: string,
): Promise<boolean> {
  const url = `${RC_API_BASE}/subscribers/${encodeURIComponent(appUserId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Platform": "stripe", // required by RC REST API for server-side calls
    },
  });

  if (res.status === 404) {
    // User not found in RevenueCat → no active subscription
    return false;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    throw new Error(`RevenueCat API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    subscriber?: {
      entitlements?: Record<
        string,
        { expires_date: string | null; product_identifier: string }
      >;
    };
  };

  const entitlement = data.subscriber?.entitlements?.[entitlementId];
  if (!entitlement) return false;

  // expires_date is null for lifetime purchases; otherwise compare to now
  if (entitlement.expires_date === null) return true;
  return new Date(entitlement.expires_date) > new Date();
}

/**
 * Fetch all pro users from the database and revert those whose RevenueCat
 * entitlement is no longer active.
 */
export async function syncSubscriptions(): Promise<void> {
  const apiKey = process.env.REVENUECAT_API_KEY;
  if (!apiKey) {
    logger.warn("subscriptionSync: REVENUECAT_API_KEY not set — skipping sync");
    return;
  }

  const entitlementId = process.env.REVENUECAT_PRO_ENTITLEMENT_ID ?? "pro";

  let proUsers: { id: number }[];
  try {
    proUsers = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.subscriptionTier, "pro"));
  } catch (err) {
    logger.error({ err }, "subscriptionSync: failed to query pro users");
    return;
  }

  logger.info(
    { count: proUsers.length },
    "subscriptionSync: checking pro users against RevenueCat",
  );

  let reverted = 0;
  let errors = 0;

  for (const user of proUsers) {
    const appUserId = String(user.id);
    try {
      const active = await hasActiveProEntitlement(
        appUserId,
        apiKey,
        entitlementId,
      );

      if (!active) {
        await db
          .update(usersTable)
          .set({ subscriptionTier: "free" })
          .where(eq(usersTable.id, user.id));
        logger.info(
          { userId: user.id },
          "subscriptionSync: reverted lapsed user to free",
        );
        reverted++;
      }
    } catch (err) {
      logger.error(
        { err, userId: user.id },
        "subscriptionSync: error checking user — skipping",
      );
      errors++;
    }
  }

  logger.info(
    { checked: proUsers.length, reverted, errors },
    "subscriptionSync: completed",
  );
}

/**
 * Register the daily cron job (runs at 03:00 every day).
 * Safe to call multiple times — the cron task is returned so callers can
 * stop it in tests.
 */
export function startSubscriptionSyncJob(): ReturnType<typeof cron.schedule> {
  logger.info("subscriptionSync: scheduling daily sync at 03:00");

  const task = cron.schedule("0 3 * * *", () => {
    syncSubscriptions().catch((err) => {
      logger.error({ err }, "subscriptionSync: unhandled error in sync job");
    });
  });

  return task;
}
