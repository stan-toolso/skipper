-- Supprimer un worktree n'efface plus ses sessions : elles sont archivées, détachées (worktree_id à NULL par la
-- clé étrangère) et gardent ici le nom, la branche et le libellé du worktree disparu, pour l'historique.
ALTER TABLE sessions ADD COLUMN former_worktree jsonb;
