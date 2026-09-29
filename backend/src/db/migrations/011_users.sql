-- Utilisateurs (connexion Google), appartenance aux projets avec rôle, sessions de connexion.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,          -- toujours en minuscules
  name          text NOT NULL,
  avatar_url    text,
  google_sub    text UNIQUE,                   -- identifiant Google, renseigné à la première connexion
  is_admin      boolean NOT NULL DEFAULT false, -- administrateur de l'application (paramètres généraux)
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TYPE project_role AS ENUM ('admin', 'member', 'viewer');

-- Un utilisateur est invité projet par projet, avec un rôle.
CREATE TABLE project_members (
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        project_role NOT NULL DEFAULT 'member',
  invited_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members (user_id);

-- Sessions de connexion (cookie) : seul le hachage du jeton est stocké.
CREATE TABLE user_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

-- Premier utilisateur : administrateur de l'application et de tous les projets existants.
INSERT INTO users (email, name, is_admin) VALUES ('stan@toolso.io', 'Stan', true);
INSERT INTO project_members (project_id, user_id, role)
SELECT p.id, u.id, 'admin' FROM projects p CROSS JOIN users u WHERE u.email = 'stan@toolso.io';
