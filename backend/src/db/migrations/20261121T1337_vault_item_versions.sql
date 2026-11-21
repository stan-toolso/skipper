-- Historique des versions des éléments du coffre : chaque modification faite par une personne ou par une session
-- d'agent (création, mise à jour, nouvelle paire de clés, secrets saisis, restauration) fige l'état complet de
-- l'élément, secrets compris (chiffrés comme l'élément : même clé de données, liée à l'identifiant de l'élément).
-- Les renouvellements automatiques de jetons (OAuth Google, Identity Center, jetons applicatifs) n'y entrent pas.
-- Supprimé avec l'élément ; les 100 dernières versions d'un élément sont gardées.
CREATE TABLE vault_item_versions (
  id                 bigserial PRIMARY KEY,
  item_id            uuid NOT NULL REFERENCES vault_items (id) ON DELETE CASCADE,
  version            integer NOT NULL,
  action             text NOT NULL,                          -- created, updated, secret_changed, key_regenerated, restored, imported
  name               text NOT NULL,
  description        text NOT NULL DEFAULT '',
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext  text,
  wrapped_key        text,
  public_key         text,
  read_only          boolean NOT NULL,
  require_approval   boolean NOT NULL,
  env_export         boolean NOT NULL DEFAULT false,
  command_allowlist  jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at         timestamptz,
  -- Ce qui a changé par rapport à la version précédente : [{ field, label, before?, after?, secret? }] (jamais de valeur secrète)
  changes            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Version restaurée (action restored)
  restored_from      integer,
  actor_user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  session_id         uuid,
  project_id         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, version),
  CHECK ((secret_ciphertext IS NULL) = (wrapped_key IS NULL))
);

-- État actuel des éléments existants comme première version (secrets au nouveau format seulement).
INSERT INTO vault_item_versions (item_id, version, action, name, description, settings, secret_ciphertext, wrapped_key, public_key,
                                 read_only, require_approval, env_export, command_allowlist, expires_at, actor_user_id, created_at)
SELECT id, 1, 'imported', name, description, settings, secret_ciphertext, wrapped_key, public_key,
       read_only, require_approval, env_export, command_allowlist, expires_at, created_by, updated_at
  FROM vault_items
 WHERE kind <> 'google' AND NOT (kind = 'token' AND settings->>'obtained' = 'oauth');
