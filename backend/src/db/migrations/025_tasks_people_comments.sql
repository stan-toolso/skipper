-- Tâches : champs personnalisés, responsable et rapporteur, commentaires, historique des sessions.

-- Champs libres clé/valeur, dans l'ordre d'affichage : [{ "key": "ticket", "value": "OPS-12" }].
ALTER TABLE tasks ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Personnes désignées librement (nom et/ou e-mail) : aucun lien avec la table users, pour nommer aussi des externes.
ALTER TABLE tasks ADD COLUMN assignee_name text;
ALTER TABLE tasks ADD COLUMN assignee_email text;   -- toujours en minuscules
ALTER TABLE tasks ADD COLUMN reporter_name text;
ALTER TABLE tasks ADD COLUMN reporter_email text;

-- Toutes les sessions passées par une tâche (celle qui l'a créée, celles qui l'ont prise ou reçue) ;
-- tasks.session_id reste la session en charge actuellement.
CREATE TABLE task_sessions (
  task_id    uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  linked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, session_id)
);
CREATE INDEX task_sessions_session_idx ON task_sessions (session_id);
INSERT INTO task_sessions (task_id, session_id, linked_at)
SELECT t.id, s.id, s.created_at FROM tasks t JOIN sessions s ON s.id IN (t.session_id, t.created_by_session_id)
ON CONFLICT DO NOTHING;

-- Commentaires des humains (interface) et des agents (outil MCP tasks.comment), en Markdown.
CREATE TABLE task_comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  author_type       text NOT NULL CHECK (author_type IN ('human', 'agent')),
  author_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  author_session_id uuid REFERENCES sessions (id) ON DELETE SET NULL,
  author_name       text NOT NULL,            -- conservé si l'utilisateur ou la session disparaît
  body              text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_comments_task_idx ON task_comments (task_id, created_at);
CREATE INDEX task_comments_author_user_idx ON task_comments (author_user_id);
CREATE INDEX task_comments_author_session_idx ON task_comments (author_session_id);

-- Clés d'API d'un projet pour l'API REST des tâches (/api/v1/tasks) : seul le hachage est conservé,
-- le secret n'est montré qu'à la création.
CREATE TABLE project_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_prefix   text NOT NULL,                 -- début du secret (skp_ + 8 caractères), pour le reconnaître
  key_hash     text NOT NULL UNIQUE,          -- sha256 hexadécimal du secret complet
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX project_api_keys_project_idx ON project_api_keys (project_id, created_at);
