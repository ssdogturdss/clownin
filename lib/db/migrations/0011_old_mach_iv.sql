-- Adds the agent_run_snapshots table that stores before-state file content
-- for each agent run so users can review what changed and restore files.
-- Also reconciles tables added via drizzle-kit push between snapshots 0003
-- and 0011 — every statement uses IF NOT EXISTS so this is safe to run
-- against databases where those tables already exist.

CREATE TABLE IF NOT EXISTS "conversation_messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" integer NOT NULL,
  "session_id" text,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promo_codes" (
  "id" serial PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "tier" text DEFAULT 'pro' NOT NULL,
  "max_uses" integer DEFAULT 1 NOT NULL,
  "used_count" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone,
  "notes" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "promo_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_configs" (
  "id" serial PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "display_name" text NOT NULL,
  "encrypted_api_key" text,
  "is_active" boolean DEFAULT false NOT NULL,
  "model" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_configs_provider_unique" UNIQUE("provider")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_sessions" (
  "session_id" text PRIMARY KEY NOT NULL,
  "project_id" integer NOT NULL,
  "name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_secrets" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "name" text NOT NULL,
  "encrypted_value" text NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_secrets_user_id_name" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promo_code_redemptions" (
  "id" serial PRIMARY KEY NOT NULL,
  "promo_code_id" integer NOT NULL,
  "user_id" integer NOT NULL,
  "redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "tier" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_run_snapshots" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "project_id" integer NOT NULL,
  "session_id" text,
  "file_snapshots" text DEFAULT '{}' NOT NULL,
  "changed_paths" text DEFAULT '[]' NOT NULL,
  "created_paths" text DEFAULT '[]' NOT NULL,
  "deleted_paths" text DEFAULT '[]' NOT NULL,
  "renamed_paths" text DEFAULT '[]' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "agent_run_snapshots_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subscription_source" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_secrets" ADD CONSTRAINT "user_secrets_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
