-- Espaces personnels et chats.

-- Un espace personnel est un projet qui appartient à une seule personne (jamais partagé) : un par personne,
-- créé à la demande. Ses sessions ont accès à l'ensemble des ressources de la personne (projets, sessions,
-- work sessions, tâches). Supprimer la personne supprime son espace.
ALTER TABLE projects ADD COLUMN personal_owner_id uuid REFERENCES users (id) ON DELETE CASCADE;
CREATE UNIQUE INDEX projects_personal_owner_idx ON projects (personal_owner_id) WHERE personal_owner_id IS NOT NULL;

-- Un chat est une session légère de l'espace personnel : pas de work session ni de conteneur, le CLI tourne sur
-- le serveur sans outil de fichiers ni de commande, seulement les outils MCP de Skipper.
ALTER TABLE sessions ADD COLUMN kind text NOT NULL DEFAULT 'session' CHECK (kind IN ('session', 'chat'));
CREATE INDEX sessions_chat_idx ON sessions (owner_id, created_at DESC) WHERE kind = 'chat';
