-- Fichiers d'environnement d'un projet (.env ou tout autre fichier texte) : écrits dans chaque nouvelle work session,
-- avec des valeurs tirées du coffre ({{vault:élément.champ}}), éditables dans l'interface et par les agents (outils `env`).
CREATE TABLE project_env_files (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  path             text NOT NULL,                        -- chemin relatif au dossier de travail (ex. ".env", "backend/.env")
  content          text NOT NULL DEFAULT '',             -- modèle : texte avec des références {{vault:élément.champ}}
  apply_on_create  boolean NOT NULL DEFAULT true,        -- écrit à la création de chaque work session
  updated_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by_session uuid REFERENCES sessions (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);

-- Un élément du coffre n'est écrit en clair dans un dossier de travail (donc lisible par l'agent) que si la
-- personne qui le gère l'a permis : par défaut, rien du coffre n'atteint le conteneur.
ALTER TABLE vault_items ADD COLUMN env_export boolean NOT NULL DEFAULT false;
