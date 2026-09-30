-- Pièces jointes de la première instruction d'une session (fichiers déposés dans la modale de lancement) :
-- métadonnées en base, fichiers dans WORKSPACES_ROOT/<slug>.attachments/<session>/<id>/<nom>.
ALTER TABLE sessions ADD COLUMN prompt_attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
