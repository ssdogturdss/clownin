-- Add subscription_source column to users table.
-- Tracks where the current subscription tier originates so the RevenueCat
-- sync job can skip users whose Pro access was granted via a promo code or
-- set manually by an admin (those sources are not tracked in RevenueCat).
--
-- Values:
--   NULL / 'revenuecat' — tier is managed by RevenueCat (default)
--   'promo'             — tier was granted by a promo code redemption
--   'admin'             — tier was manually set by an admin

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subscription_source" text;
