-- Planification d'une session : à chaque échéance de l'expression cron, l'instruction `prompt` est
-- envoyée à la session (relancée si elle est terminée). Une ligne par session au plus.
CREATE TABLE session_schedules (
  session_id    uuid PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  cron          text NOT NULL,                       -- 5 champs : minute heure jour mois jour-de-semaine
  timezone      text NOT NULL DEFAULT 'UTC',         -- fuseau IANA dans lequel l'expression est interprétée
  prompt        text NOT NULL,                       -- instruction envoyée à chaque exécution
  enabled       boolean NOT NULL DEFAULT true,
  end_after_run boolean NOT NULL DEFAULT true,       -- terminer la session à la fin de chaque exécution
  next_run_at   timestamptz,                         -- prochaine échéance (null si désactivée)
  last_run_at   timestamptz,
  last_result   text,                                -- compte rendu de la dernière exécution (terminée, ignorée, erreur)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_schedules_due_idx ON session_schedules (next_run_at) WHERE enabled;
