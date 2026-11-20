-- ---- Résumé d'une tâche --------------------------------------------------------------------------------------------
-- Une ou deux phrases qui disent l'objet de la tâche, montrées avant la description pour être lues et comprises
-- rapidement (page de la tâche, panneau, cartes, prompt des agents). Null : pas de résumé.
ALTER TABLE tasks ADD COLUMN summary text;
