-- Statuts de tâches propres à chaque projet : chaque statut a une clé, un
-- libellé et une catégorie (todo, in_progress, done, cancelled) qui porte le sens (ouverte, bloquante, cycle time…).
-- projects.task_statuses NULL : les statuts par défaut (backend/src/tasks/statuses.ts).
ALTER TABLE projects ADD COLUMN task_statuses jsonb;
-- Statut de la tâche dans le projet (clé) ; NULL : le statut par défaut de sa catégorie.
ALTER TABLE tasks ADD COLUMN state text;
