-- Branche git sur laquelle une tâche est traitée (worktree dédié task/<slug>). Conservée après la
-- suppression du worktree pour retrouver la pull request de la tâche.
ALTER TABLE tasks ADD COLUMN branch text;

UPDATE tasks t
SET branch = w.branch
FROM sessions s
JOIN worktrees w ON w.id = s.worktree_id
WHERE t.session_id = s.id AND t.branch IS NULL;
