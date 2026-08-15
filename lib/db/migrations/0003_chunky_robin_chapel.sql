-- Adds SSH server table, server_id FK on projects, and per-project env vars.
-- Uses IF NOT EXISTS / IF NOT EXISTS guards so this migration is safe to apply
-- against databases where servers/env_vars were already provisioned via drizzle-kit push.

CREATE TABLE IF NOT EXISTS "servers" (
"id" serial PRIMARY KEY NOT NULL,
"user_id" integer NOT NULL,
"name" text NOT NULL,
"host" text NOT NULL,
"port" integer DEFAULT 22 NOT NULL,
"username" text NOT NULL,
"password" text,
"private_key" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "server_id" integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_env_vars" (
"id" serial PRIMARY KEY NOT NULL,
"project_id" integer NOT NULL,
"key" text NOT NULL,
"encrypted_value" text NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "project_env_vars_project_id_key" UNIQUE("project_id","key")
);
