-- Adds session_id column to conversation_messages so messages can be grouped
-- into discrete conversation threads per project.
-- IF NOT EXISTS guards make this safe to re-run against databases where the
-- column was already provisioned via drizzle-kit push.

ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "session_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_messages_session_idx"
  ON "conversation_messages" ("project_id", "session_id");
