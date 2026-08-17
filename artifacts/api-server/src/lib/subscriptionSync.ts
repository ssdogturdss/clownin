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
 *
 * Concurrency is capped at REVENUECAT_SYNC_CONCURRENCY (default: 5) parallel
 * requests. 429 responses trigger exponential back-off with up to
 * REVENUECAT_SYNC_MAX_RETRIES (default: 4) retries.
 *
 * Transient 5xx failures are retried up to REVENUECAT_SYNC_ERROR_RETRIES
 * (default: 2) times per user before counting as an error. After the full sync
 * completes, a structured warning is emitted when any errors remain so that
 * monitoring tools can detect a prolonged RevenueCat outage.
 */

import cron from "node-cron";
import pLimit from "p-limit";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const RC_API_BASE = "https://api.revenuecat.com/v1";

/** How long to wait (ms) before the first retry on a 429. Doubles each attempt. */
const BACKOFF_BASE_MS = 1_000;

/**
 * Sleep for `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check whether a given RC app_user_id (= String(user.id)) has an active
 * Pro entitlement right now according to the RevenueCat REST API.
 *
 * Returns `true` if the entitlement is active, `false` otherwise.
 * Retries up to `maxRetries` times on 429 responses with exponential back-off.
 * Throws on network / auth errors so the caller can decide whether to skip.
 */
async function hasActiveProEntitlement(
  appUserId: string,
  apiKey: string,
  entitlementId: string,
  maxRetries: number = 4,
): Promise<boolean> {
  const url = `${RC_API_BASE}/subscribers/${encodeURIComponent(appUserId)}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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

    if (res.status === 429) {
      if (attempt === maxRetries) {
        const text = await res.text().catch(() => "(unreadable)");
        throw new Error(
          `RevenueCat rate-limited after ${maxRetries + 1} attempts: ${text}`,
        );
      }
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
      logger.warn(
        { appUserId, attempt, backoffMs },
        "subscriptionSync: rate-limited by RevenueCat, backing off",
      );
      await sleep(backoffMs);
      continue;
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

  // Unreachable, but satisfies TypeScript
  throw new Error("Unexpected exit from retry loop");
}

/**
 * Fetch all pro users from the database and revert those whose RevenueCat
 * entitlement is no longer active.
 *
 * Requests run at most `concurrency` at a time to avoid hammering the
 * RevenueCat API when there are many Pro users.
 */
export async function syncSubscriptions(): Promise<void> {
  const apiKey = process.env.REVENUECAT_API_KEY;
  if (!apiKey) {
    logger.warn("subscriptionSync: REVENUECAT_API_KEY not set — skipping sync");
    return;
  }

  const entitlementId = process.env.REVENUECAT_PRO_ENTITLEMENT_ID ?? "pro";
  const concurrency = parseInt(
    process.env.REVENUECAT_SYNC_CONCURRENCY ?? "5",
    10,
  );
  const maxRetries = parseInt(
    process.env.REVENUECAT_SYNC_MAX_RETRIES ?? "4",
    10,
  );
  const errorRetries = parseInt(
    process.env.REVENUECAT_SYNC_ERROR_RETRIES ?? "2",
    10,
  );

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
    { count: proUsers.length, concurrency, maxRetries },
    "subscriptionSync: checking pro users against RevenueCat",
  );

  let reverted = 0;
  let errors = 0;

  const limit = pLimit(concurrency);

  const tasks = proUsers.map((user) =>
    limit(async () => {
      const appUserId = String(user.id);

      let lastErr: unknown;
      for (let attempt = 0; attempt <= errorRetries; attempt++) {
        try {
          const active = await hasActiveProEntitlement(
            appUserId,
            apiKey,
            entitlementId,
            maxRetries,
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
          // Success — no more retries needed
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < errorRetries) {
            const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
            logger.warn(
              { err, userId: user.id, attempt, backoffMs },
              "subscriptionSync: transient error checking user — retrying",
            );
            await sleep(backoffMs);
          }
        }
      }

      if (lastErr !== undefined) {
        logger.error(
          { err: lastErr, userId: user.id },
          "subscriptionSync: error checking user — skipping",
        );
        errors++;
      }
    }),
  );

  await Promise.all(tasks);

  if (errors > 0) {
    logger.warn(
      {
        syncErrors: errors,
        checked: proUsers.length,
        reverted,
      },
      "subscriptionSync: completed with errors — RevenueCat may be degraded; manual review recommended",
    );
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
