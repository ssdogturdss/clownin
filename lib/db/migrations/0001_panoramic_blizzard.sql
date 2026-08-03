-- Adds subscription tier tracking to the users table.
-- Uses ADD COLUMN IF NOT EXISTS so this migration is safe to apply
-- against databases where these columns were already added via drizzle-kit push.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subscription_tier" text DEFAULT 'free' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "daily_message_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_message_date" text;
