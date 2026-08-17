import { Router, type IRouter } from "express";
import { db, usersTable, promoCodesTable, promoCodeRedemptionsTable } from "@workspace/db";
import { eq, and, lt, gt, isNull, or, sql } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { z } from "zod";

const router: IRouter = Router();

const redeemSchema = z.object({
  code: z.string().min(1),
});

router.post("/promo-codes/redeem", requireAuth, async (req, res): Promise<void> => {
  const parsed = redeemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "code is required" });
    return;
  }

  const { code } = parsed.data;
  const { userId } = getUser(req);

  // Pre-read the promo code for a fast, user-friendly validation response.
  // The actual claim is atomic (see below), so this read is not the gate.
  const [promo] = await db
    .select()
    .from(promoCodesTable)
    .where(eq(promoCodesTable.code, code.trim().toUpperCase()));

  if (!promo) {
    res.status(404).json({ error: "Invalid promo code" });
    return;
  }

  if (!promo.isActive) {
    res.status(410).json({ error: "This promo code has already been used up" });
    return;
  }

  const now = new Date();
  if (promo.expiresAt && promo.expiresAt < now) {
    res.status(410).json({ error: "This promo code has expired" });
    return;
  }

  // Check if the user is already on this tier.
  const [user] = await db
    .select({ subscriptionTier: usersTable.subscriptionTier })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (user?.subscriptionTier === promo.tier) {
    res.status(409).json({ error: `You are already on the ${promo.tier} plan` });
    return;
  }

  // Atomically claim one use of the promo code.
  //
  // The UPDATE's WHERE clause re-checks every condition that matters:
  //   - still active
  //   - not expired
  //   - used_count < max_uses   (the race-safe gate)
  //
  // If a concurrent request beats us here, no rows are updated and we detect
  // it via .returning(), then roll the transaction back and return 410.
  //
  // is_active is flipped to false in-database when the last use is claimed so
  // no separate UPDATE is needed and no window exists for a second request to
  // sneak in between two writes.

  type ClaimResult = { id: number; tier: string };
  let claimed: ClaimResult | undefined;

  try {
    await db.transaction(async (tx) => {
      const claimResult = await tx
        .update(promoCodesTable)
        .set({
          usedCount: sql`${promoCodesTable.usedCount} + 1`,
          isActive: sql`CASE WHEN ${promoCodesTable.usedCount} + 1 >= ${promoCodesTable.maxUses} THEN false ELSE ${promoCodesTable.isActive} END`,
        })
        .where(
          and(
            eq(promoCodesTable.id, promo.id),
            eq(promoCodesTable.isActive, true),
            lt(promoCodesTable.usedCount, promoCodesTable.maxUses),
            or(
              isNull(promoCodesTable.expiresAt),
              gt(promoCodesTable.expiresAt, now),
            ),
          ),
        )
        .returning({ id: promoCodesTable.id, tier: promoCodesTable.tier });

      if (claimResult.length === 0) {
        // Concurrent request already exhausted or expired the code — rollback.
        throw new Error("PROMO_CLAIM_FAILED");
      }

      claimed = claimResult[0];

      // Upgrade the user's tier and record the source so the RevenueCat sync
      // does not revert promo-granted access.
      await tx
        .update(usersTable)
        .set({ subscriptionTier: claimed.tier, subscriptionSource: "promo" })
        .where(eq(usersTable.id, userId));

      // Record redemption history for admin visibility.
      await tx.insert(promoCodeRedemptionsTable).values({
        promoCodeId: promo.id,
        userId,
        tier: claimed.tier,
      });
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "PROMO_CLAIM_FAILED") {
      res.status(410).json({ error: "This promo code has no remaining uses" });
      return;
    }
    throw err;
  }

  const tier = claimed!.tier;
  res.json({
    tier,
    message: `🎉 You're now on the ${tier.charAt(0).toUpperCase() + tier.slice(1)} plan!`,
  });
});

export default router;
