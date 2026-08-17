-- Creates a lightweight table that holds per-session metadata (currently just
-- the human-readable name). One row per session_id; optional — sessions that
-- pre-date this migration simply won't have a name row.

CREATE TABLE IF NOT EXISTS "conversation_sessions" (
  "session_id" text PRIMARY KEY,
  "project_id" integer NOT NULL,
  "name"       text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
