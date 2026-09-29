-- Terminaux web : un shell interactif (pty) lancé dans le workspace d'un projet.
CREATE TYPE terminal_status AS ENUM ('running', 'closed');

CREATE TABLE terminals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name        text NOT NULL,
  status      terminal_status NOT NULL DEFAULT 'running',
  exit_code   integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);
CREATE INDEX terminals_project_idx ON terminals (project_id, created_at DESC);
