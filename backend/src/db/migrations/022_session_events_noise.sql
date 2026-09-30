-- Journal des sessions : les compteurs et états intermédiaires du SDK ne sont plus enregistrés
-- (voir sessions/providers/claudeNoise.ts) ; suppression des lignes déjà stockées.
DELETE FROM session_events
WHERE type = 'claude.tool_progress'
   OR (type = 'claude.system' AND payload->>'subtype' IN ('thinking_tokens', 'task_progress', 'task_updated', 'background_tasks_changed', 'vcs_state_changed'));

-- Purge par ancienneté (rétention du transcript, `deleteEventsBefore`).
CREATE INDEX IF NOT EXISTS session_events_session_created_idx ON session_events (session_id, created_at);
