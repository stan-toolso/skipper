-- ---- Sous-agents du CLI en cours dans une session ----------------------------------------------------------------
-- Les sous-agents lancés par l'outil Agent du CLI (premier plan ou arrière-plan) ne sont pas des sessions Skipper : la
-- session tient ici la liste de ceux qui tournent (description, type, début, avancement), tenue à jour par le provider
-- (sessions/providers/subagents.ts) et montrée dans la sidebar. Vidée à la fin de chaque exécution du CLI.
ALTER TABLE sessions ADD COLUMN subagents jsonb NOT NULL DEFAULT '[]'::jsonb;
