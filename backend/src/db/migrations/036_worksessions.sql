-- Les worktrees deviennent des work sessions : l'unité de travail d'un projet (un git worktree pour un projet
-- relié à un dépôt, un simple dossier sinon). Toute nouvelle session et tout nouveau terminal en ont une : plus
-- rien ne s'exécute dans le checkout principal. Les dossiers restent sous <slug>.worktrees/ sur le disque.
ALTER TABLE worktrees RENAME TO worksessions;
ALTER INDEX IF EXISTS worktrees_pkey RENAME TO worksessions_pkey;
ALTER INDEX IF EXISTS worktrees_project_id_name_key RENAME TO worksessions_project_id_name_key;
ALTER INDEX IF EXISTS worktrees_archived_idx RENAME TO worksessions_archived_idx;
ALTER TABLE sessions RENAME COLUMN worktree_id TO worksession_id;
ALTER INDEX IF EXISTS sessions_worktree_idx RENAME TO sessions_worksession_idx;
ALTER TABLE sessions RENAME COLUMN former_worktree TO former_worksession;
ALTER TABLE terminals RENAME COLUMN worktree_id TO worksession_id;
ALTER INDEX IF EXISTS terminals_worktree_idx RENAME TO terminals_worksession_idx;
ALTER TABLE agents RENAME COLUMN worktree_id TO worksession_id;

-- La tâche à laquelle une work session est consacrée : une seule par tâche, réutilisée par ses sessions suivantes.
ALTER TABLE worksessions ADD COLUMN task_id uuid REFERENCES tasks (id) ON DELETE SET NULL;
CREATE INDEX worksessions_task_idx ON worksessions (task_id) WHERE task_id IS NOT NULL;
UPDATE worksessions w SET task_id = t.id
  FROM tasks t
 WHERE t.project_id = w.project_id AND t.branch IS NOT NULL AND t.branch = w.branch AND w.task_id IS NULL;

-- Nœuds des workflows : les clés suivent le renommage, et le mode « dossier principal » n'existe plus.
UPDATE workflows
   SET definition = replace(replace(replace(definition::text, '"worktreeMode"', '"worksessionMode"'), '"worktreeId"', '"worksessionId"'), '"worksessionMode": "main"', '"worksessionMode": "new"')::jsonb
 WHERE definition::text LIKE '%"worktree%';

-- Outils MCP renommés (worktrees → worksessions) dans les autorisations mémorisées.
UPDATE project_permission_rules SET tool_name = replace(tool_name, 'mcp__worktrees__', 'mcp__worksessions__') WHERE tool_name LIKE 'mcp__worktrees__%';
