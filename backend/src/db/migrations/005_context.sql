-- Contexte d'un projet : bibliothèque d'instructions rangées en dossiers, versionnée.

CREATE TABLE context_folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES context_folders (id) ON DELETE CASCADE,   -- NULL = racine
  name        text NOT NULL,
  slug        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX context_folders_unique_slug
  ON context_folders (project_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
CREATE INDEX context_folders_project_idx ON context_folders (project_id);

CREATE TABLE context_instructions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  folder_id   uuid REFERENCES context_folders (id) ON DELETE CASCADE,   -- NULL = racine
  name        text NOT NULL,
  slug        text NOT NULL,
  description text NOT NULL DEFAULT '',
  content     text NOT NULL DEFAULT '',
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX context_instructions_unique_slug
  ON context_instructions (project_id, COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
CREATE INDEX context_instructions_project_idx ON context_instructions (project_id);

-- Chaque modification de contenu crée une version ; permet l'historique et la restauration.
CREATE TABLE context_instruction_versions (
  id                bigserial PRIMARY KEY,
  instruction_id    uuid NOT NULL REFERENCES context_instructions (id) ON DELETE CASCADE,
  version           integer NOT NULL,
  name              text NOT NULL,
  description       text NOT NULL,
  content           text NOT NULL,
  change_note       text,
  author_type       text NOT NULL CHECK (author_type IN ('human', 'agent')),
  author_session_id uuid REFERENCES sessions (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instruction_id, version)
);

-- Journal de toutes les opérations sur le contexte d'un projet (structure comprise).
CREATE TABLE context_changes (
  id                bigserial PRIMARY KEY,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind              text NOT NULL,          -- folder.create, folder.rename, folder.move, folder.delete,
                                            -- instruction.create, instruction.update, instruction.move,
                                            -- instruction.delete, instruction.restore
  path              text NOT NULL,
  details           jsonb NOT NULL DEFAULT '{}',
  author_type       text NOT NULL CHECK (author_type IN ('human', 'agent')),
  author_session_id uuid REFERENCES sessions (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX context_changes_project_idx ON context_changes (project_id, id DESC);
