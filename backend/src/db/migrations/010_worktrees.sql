-- Worktrees git d'un projet : un dossier par branche, à côté du checkout principal.
CREATE TABLE worktrees (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name        text NOT NULL,                 -- nom du dossier (slug)
  branch      text NOT NULL,                 -- branche extraite dans ce worktree
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

-- Une session ou un terminal peut s'exécuter dans un worktree plutôt que dans le checkout principal.
ALTER TABLE sessions ADD COLUMN worktree_id uuid REFERENCES worktrees (id) ON DELETE SET NULL;
ALTER TABLE terminals ADD COLUMN worktree_id uuid REFERENCES worktrees (id) ON DELETE SET NULL;
CREATE INDEX sessions_worktree_idx ON sessions (worktree_id);
CREATE INDEX terminals_worktree_idx ON terminals (worktree_id);
