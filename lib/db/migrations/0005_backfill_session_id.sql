-- Backfill: assign a stable session UUID to all pre-existing messages that
-- have no session_id (i.e. messages created before the session feature landed).
-- Groups by project_id so every message in the same project gets the same UUID,
-- preserving thread continuity for existing users.
UPDATE conversation_messages AS m
SET session_id = project_sessions.new_uuid
FROM (
  SELECT project_id, gen_random_uuid()::text AS new_uuid
  FROM (
    SELECT DISTINCT project_id
    FROM conversation_messages
    WHERE session_id IS NULL
  ) AS projects_with_legacy
) AS project_sessions
WHERE m.project_id = project_sessions.project_id
  AND m.session_id IS NULL;
