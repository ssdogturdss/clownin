import { pgTable, serial, integer, timestamp, text } from "drizzle-orm/pg-core";

/**
 * Records every successful promo code redemption.
 * One row per redemption event — allows admins to see who used each code and when.
 */
export const promoCodeRedemptionsTable = pgTable("promo_code_redemptions", {
  id: serial("id").primaryKey(),
  promoCodeId: integer("promo_code_id").notNull(),
  userId: integer("user_id").notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
  /** Snapshot of the tier granted at time of redemption */
  tier: text("tier").notNull(),
});

export type PromoCodeRedemption = typeof promoCodeRedemptionsTable.$inferSelect;
