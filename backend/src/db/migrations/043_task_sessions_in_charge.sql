-- Plusieurs sessions peuvent être en charge d'une même tâche, et une session de plusieurs tâches.
-- task_sessions garde tout l'historique des sessions passées par une tâche ; in_charge_since (null : simple
-- passage) dit lesquelles en ont la charge aujourd'hui, et depuis quand. tasks.session_id reste la plus récente
-- des sessions en charge (dénormalisation maintenue par le dépôt, pour les lectures qui n'en veulent qu'une).
ALTER TABLE task_sessions ADD COLUMN in_charge_since timestamptz;

UPDATE task_sessions ts SET in_charge_since = ts.linked_at
FROM tasks t WHERE t.id = ts.task_id AND t.session_id = ts.session_id;

-- Sécurité : une session en charge d'après tasks.session_id sans ligne d'historique.
INSERT INTO task_sessions (task_id, session_id, linked_at, in_charge_since)
SELECT id, session_id, updated_at, updated_at FROM tasks WHERE session_id IS NOT NULL
ON CONFLICT (task_id, session_id) DO UPDATE SET in_charge_since = COALESCE(task_sessions.in_charge_since, EXCLUDED.in_charge_since);

CREATE INDEX task_sessions_in_charge_idx ON task_sessions (session_id, in_charge_since) WHERE in_charge_since IS NOT NULL;
