-- Adds preview sharing fields to the projects table.
-- Uses ADD COLUMN IF NOT EXISTS so this migration is safe to re-apply.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "preview_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "preview_short_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_preview_short_id_idx" ON "projects" ("preview_short_id") WHERE "preview_short_id" IS NOT NULL;
