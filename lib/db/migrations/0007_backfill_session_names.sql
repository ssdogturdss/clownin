-- Backfill: insert a name row into conversation_sessions for every session that
-- has messages but no name entry yet (i.e. sessions created before auto-naming
-- was introduced). Sessions that were already manually renamed are left untouched
-- because the WHERE NOT EXISTS guard and ON CONFLICT DO NOTHING both protect them.
--
-- Name heuristic: first 6 whitespace-delimited words of the earliest user
-- message in the session, with trailing sentence punctuation stripped —
-- identical to the runtime logic in artifacts/api-server/src/routes/agent.ts.

INSERT INTO conversation_sessions (session_id, project_id, name)
SELECT
  first_msg.session_id,
  first_msg.project_id,
  regexp_replace(
    array_to_string(
      (string_to_array(trim(first_msg.content), ' '))[1:6],
      ' '
    ),
    '[.!?]+$',
    ''
  ) AS name
FROM (
  -- One row per session: pick the earliest user message
  SELECT DISTINCT ON (session_id)
    session_id,
    project_id,
    content
  FROM conversation_messages
  WHERE session_id IS NOT NULL
    AND role = 'user'
    AND content IS NOT NULL
    AND trim(content) <> ''
  ORDER BY session_id, created_at ASC
) AS first_msg
WHERE NOT EXISTS (
  SELECT 1
  FROM conversation_sessions cs
  WHERE cs.session_id = first_msg.session_id
)
ON CONFLICT (session_id) DO NOTHING;
