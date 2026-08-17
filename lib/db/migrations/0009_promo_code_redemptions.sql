-- Creates promo_code_redemptions table to track every successful code redemption.
-- Allows admins to see who used each code and when.

CREATE TABLE IF NOT EXISTS "promo_code_redemptions" (
  "id"             serial PRIMARY KEY,
  "promo_code_id"  integer NOT NULL,
  "user_id"        integer NOT NULL,
  "redeemed_at"    timestamptz NOT NULL DEFAULT now(),
  "tier"           text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promo_code_redemptions_code_idx"
  ON "promo_code_redemptions" ("promo_code_id", "redeemed_at" DESC);
