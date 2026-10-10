-- Worktrees : libellé libre et archivage.

-- Libellé affiché dans l'interface (texte libre) ; NULL : la branche est affichée.
ALTER TABLE worktrees ADD COLUMN label text;

-- Archivé : ses sessions sont archivées avec lui, son dossier est conservé sur disque, la branche aussi ;
-- restaurable avec ses sessions depuis l'historique du projet.
ALTER TABLE worktrees ADD COLUMN archived_at timestamptz;
CREATE INDEX worktrees_archived_idx ON worktrees (project_id, archived_at DESC) WHERE archived_at IS NOT NULL;
