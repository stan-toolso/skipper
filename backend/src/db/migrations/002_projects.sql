CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,          -- nom du dossier dans WORKSPACES_ROOT
  description   text,
  system_prompt text NOT NULL DEFAULT '',
  git_url       text,                          -- dépôt cloné dans le workspace (optionnel)
  git_branch    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sessions ADD COLUMN project_id uuid REFERENCES projects (id) ON DELETE CASCADE;

-- Les sessions existantes sont rattachées à un projet par défaut.
INSERT INTO projects (name, slug, description)
SELECT 'Default', 'default', 'Projet créé automatiquement pour les sessions antérieures'
WHERE EXISTS (SELECT 1 FROM sessions);

UPDATE sessions SET project_id = (SELECT id FROM projects WHERE slug = 'default') WHERE project_id IS NULL;

ALTER TABLE sessions ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX sessions_project_idx ON sessions (project_id, created_at DESC);
