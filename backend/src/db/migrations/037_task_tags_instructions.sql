-- Tâches (repris de Cockpit).
-- Étiquette d'état : court libellé libre de l'avancement dans le statut (« en revue », « bloquée »,
-- « attend la CI »…), posé par les personnes ou par la session en charge ; affiché à côté du statut.
-- Étiquettes : libellés libres d'une tâche (plusieurs), pour regrouper et filtrer.
ALTER TABLE tasks ADD COLUMN status_tag text;
ALTER TABLE tasks ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX tasks_tags_idx ON tasks USING gin (tags);

-- Consignes ajoutées à l'instruction de toute session qui réalise une tâche du projet (après le texte de
-- la tâche) : la procédure ou le skill à suivre, par exemple. Vide : aucune.
ALTER TABLE projects ADD COLUMN task_instructions text NOT NULL DEFAULT '';
