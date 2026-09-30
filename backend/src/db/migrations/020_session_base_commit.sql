-- Commit HEAD du dossier de travail au premier démarrage de la session : référence de l'onglet « Modifications »
-- (commits de l'agent compris). Null : dossier sans git, ou session démarrée avant cette migration.
ALTER TABLE sessions ADD COLUMN base_commit text;
