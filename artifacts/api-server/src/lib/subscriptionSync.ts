/**
 * Subscription sync job.
 *
 * Runs every 6 hours and verifies every user whose subscriptionTier is 'pro'
 * still has an active entitlement in RevenueCat. If RevenueCat says the
 * entitlement is gone or expired the user is reverted to 'free' so stale state
 * from a missed/failed webhook delivery is healed.
 *
 * Running every 6 hours (instead of once per day) means the maximum recovery
 * window after a RevenueCat outage is 6 hours rather than 24 hours. The revert
 * logic is fully idempotent — running it multiple times on the same user is
 * safe and produces no duplicate side-effects.
 *
 * Catch-up on partial failure:
 *   When a sync run finishes with errors > 0 (RevenueCat returned 5xx for some
 *   users), a one-shot follow-up sync is automatically scheduled
 *   SYNC_CATCHUP_DELAY_MS milliseconds later (default: 2 hours). At most one
 *   catch-up is queued at a time; if the catch-up run also has errors the next
 *   scheduled 6-hour cron will pick up naturally.
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
 *
 * Out-of-band alerting:
 *   SYNC_ALERT_WEBHOOK_URL — optional URL that receives a POST request when
 *                            syncErrors > 0. Compatible with Slack Incoming
 *                            Webhooks and any endpoint that accepts a JSON body
 *                            with a `text` field. The payload includes the
 *                            error count, users checked, and UTC timestamp so
 *                            the on-call team has actionable context immediately.
 *
 * Catch-up delay:
 *   SYNC_CATCHUP_DELAY_MS — milliseconds to wait before the automatic follow-up
 *                           sync when a run finishes with errors. Default: 7200000
 *                           (2 hours). Set to 0 to disable catch-up scheduling.
 */

import cron from "node-cron";
import pLimit from "p-limit";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const RC_API_BASE = "https://api.revenuecat.com/v1";

/** How long to wait (ms) before the first retry on a 429. Doubles each attempt. */
const BACKOFF_BASE_MS = 1_000;

/** Default delay (ms) before a catch-up sync is triggered after errors. 2 hours. */
const DEFAULT_CATCHUP_DELAY_MS = 2 * 60 * 60 * 1_000;

/**
 * Handle for the pending catch-up timer. Kept module-level so we can cancel a
 * previous pending catch-up if a new one would otherwise stack up.
 */
let pendingCatchup: ReturnType<typeof setTimeout> | null = null;

/**
 * Send an out-of-band alert to the configured webhook URL when the sync
 * finishes with errors. The payload is compatible with Slack Incoming Webhooks
 * (`{ text: "..." }`) and any endpoint that accepts a plain JSON POST.
 *
 * Swallows errors so a broken webhook never prevents the sync from completing.
 */
export async function sendSyncErrorAlert(
  syncErrors: number,
  checked: number,
  timestamp: string,
  webhookUrl: string,
): Promise<void> {
  const text =
    `⚠️ *Subscription sync completed with errors* — RevenueCat may be degraded.\n` +
    `• Errors: ${syncErrors} / ${checked} users checked\n` +
    `• Time: ${timestamp}\n` +
    `Manual review recommended.`;

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      logger.warn(
        { status: res.status, body },
        "subscriptionSync: alert webhook returned non-2xx response",
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "subscriptionSync: failed to send alert webhook — continuing",
    );
  }
}

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
 * Schedule a one-shot catch-up sync to run after `delayMs` milliseconds.
 *
 * At most one catch-up is queued at a time. If a previous catch-up is still
 * pending it is cancelled and replaced so timers do not accumulate during a
 * prolonged outage where every run returns errors.
 */
function scheduleCatchupSync(delayMs: number): void {
  // Cancel any existing pending catch-up
  if (pendingCatchup !== null) {
    clearTimeout(pendingCatchup);
    logger.info(
      "subscriptionSync: replaced existing catch-up timer with a fresh one",
    );
  }

  const delayMinutes = Math.round(delayMs / 60_000);
  logger.info(
    { delayMs, delayMinutes },
    "subscriptionSync: scheduling catch-up sync due to errors",
  );

  pendingCatchup = setTimeout(() => {
    pendingCatchup = null;
    logger.info("subscriptionSync: running catch-up sync after error delay");
    syncSubscriptions().catch((err) => {
      logger.error({ err }, "subscriptionSync: unhandled error in catch-up sync");
    });
  }, delayMs);
}

/**
 * Fetch all pro users from the database and revert those whose RevenueCat
 * entitlement is no longer active.
 *
 * Requests run at most `concurrency` at a time to avoid hammering the
 * RevenueCat API when there are many Pro users.
 *
 * When the run finishes with errors > 0 a catch-up sync is automatically
 * scheduled via `scheduleCatchupSync` so users missed during a RevenueCat
 * outage are recovered as soon as the service comes back, rather than waiting
 * for the next scheduled cron window (up to 6 hours away).
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
  const catchupDelayMs = parseInt(
    process.env.SYNC_CATCHUP_DELAY_MS ?? String(DEFAULT_CATCHUP_DELAY_MS),
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
    const timestamp = new Date().toISOString();
    logger.warn(
      {
        syncErrors: errors,
        checked: proUsers.length,
        reverted,
        timestamp,
      },
      "subscriptionSync: completed with errors — RevenueCat may be degraded; manual review recommended",
    );

    const webhookUrl = process.env.SYNC_ALERT_WEBHOOK_URL;
    if (webhookUrl) {
      await sendSyncErrorAlert(errors, proUsers.length, timestamp, webhookUrl);
    } else {
      logger.warn(
        "subscriptionSync: SYNC_ALERT_WEBHOOK_URL not set — skipping out-of-band alert",
      );
    }

    // Schedule a catch-up sync to recover users that were skipped during a
    // RevenueCat outage. If SYNC_CATCHUP_DELAY_MS is 0 the operator has
    // opted out of automatic catch-ups.
    if (catchupDelayMs > 0) {
      scheduleCatchupSync(catchupDelayMs);
    }
  }

  logger.info(
    { checked: proUsers.length, reverted, errors },
    "subscriptionSync: completed",
  );
}

/**
 * Register the subscription sync cron job.
 *
 * The job runs every 6 hours (at 00:00, 06:00, 12:00, 18:00 server time).
 * Running every 6 hours instead of once per day means that in the worst case
 * (RevenueCat down for an entire 6-hour window) users who should have been
 * reverted are caught within 6 hours rather than up to 24 hours.
 *
 * The underlying revert logic is fully idempotent — re-checking a user who is
 * already on "free" simply confirms they have no active entitlement and makes
 * no database write. Users already correctly on "pro" are left untouched.
 *
 * Safe to call multiple times — the cron task is returned so callers can
 * stop it in tests.
 */
export function startSubscriptionSyncJob(): ReturnType<typeof cron.schedule> {
  logger.info(
    "subscriptionSync: scheduling sync every 6 hours (00:00, 06:00, 12:00, 18:00)",
  );

  const task = cron.schedule("0 */6 * * *", () => {
    syncSubscriptions().catch((err) => {
      logger.error({ err }, "subscriptionSync: unhandled error in sync job");
    });
  });

  return task;
}
