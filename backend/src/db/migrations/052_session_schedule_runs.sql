-- Planifications lisibles : un nom propre (distinct du nom de la session) et l'historique des exécutions.
-- Compatible avec la version précédente (bleu/vert) : elle ignore la colonne `name` et continue d'écrire
-- `last_result`, que la nouvelle version tient aussi à jour.
ALTER TABLE session_schedules ADD COLUMN IF NOT EXISTS name text;

-- Une ligne par exécution (lancée, ignorée ou manquée) d'une planification.
CREATE TABLE IF NOT EXISTS session_schedule_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  trigger        text NOT NULL,                     -- schedule (échéance) | manual (« Exécuter maintenant »)
  triggered_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  status         text NOT NULL,                     -- running | done | blocked | failed | timeout | skipped | missed
  scheduled_for  timestamptz,                       -- échéance visée (null pour une exécution à la main)
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  cost_usd       double precision,
  duration_ms    integer,
  message        text,                              -- raison, erreur, outil refusé…
  answer         text,                              -- début de la dernière réponse de l'agent
  start_event_id bigint                             -- événement `schedule` (action run) qui ouvre l'exécution dans le transcript
);

CREATE INDEX IF NOT EXISTS session_schedule_runs_session_idx ON session_schedule_runs (session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS session_schedule_runs_running_idx ON session_schedule_runs (started_at) WHERE status = 'running';
