CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE session_status AS ENUM (
  'pending',      -- créée, pas encore démarrée
  'running',      -- processus en cours
  'completed',    -- terminée normalement
  'failed',       -- terminée en erreur
  'stopped',      -- arrêtée par l'utilisateur
  'interrupted'   -- perdue suite à un redémarrage du serveur
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  provider    text NOT NULL,                 -- 'claude', 'shell', ...
  status      session_status NOT NULL DEFAULT 'pending',
  prompt      text,                          -- instruction initiale
  config      jsonb NOT NULL DEFAULT '{}',   -- options propres au provider (cwd, model, ...)
  external_id text,                          -- identifiant côté provider (ex. session_id Claude)
  exit_code   integer,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  ended_at    timestamptz
);

CREATE INDEX sessions_status_idx ON sessions (status);
CREATE INDEX sessions_created_at_idx ON sessions (created_at DESC);

CREATE TABLE session_events (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  type        text NOT NULL,                 -- 'stdout', 'stderr', 'message', 'status', 'system', ...
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_events_session_idx ON session_events (session_id, id);
