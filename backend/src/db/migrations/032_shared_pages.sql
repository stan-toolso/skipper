-- Pages partagées : fichiers HTML publiés par une personne ou un agent, servis à /shared/<id>,
-- privés par défaut, partagés avec des personnes ou avec quiconque est connecté et a le lien.
CREATE TABLE shared_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text,
  link_access boolean NOT NULL DEFAULT false,   -- quiconque est connecté avec le lien
  version     integer NOT NULL DEFAULT 1,       -- numéro de la dernière version
  project_id  uuid REFERENCES projects (id) ON DELETE SET NULL,   -- origine, indicatif
  session_id  uuid REFERENCES sessions (id) ON DELETE SET NULL,
  source_path text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shared_pages_owner_idx ON shared_pages (owner_id, updated_at DESC);

-- Contenu de chaque version (10 Mo au plus).
CREATE TABLE shared_page_versions (
  page_id    uuid NOT NULL REFERENCES shared_pages (id) ON DELETE CASCADE,
  version    integer NOT NULL,
  html       bytea NOT NULL,
  size       integer NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, version)
);

CREATE TABLE shared_page_members (
  page_id    uuid NOT NULL REFERENCES shared_pages (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  added_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX shared_page_members_user_idx ON shared_page_members (user_id);
