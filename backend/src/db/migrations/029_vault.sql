-- Coffre : remplace les connexions des projets et les comptes Google des projets par des éléments
-- appartenant à un utilisateur (coffre personnel) ou à un projet, partagés avec des personnes et
-- reliés à des projets. Les secrets sont chiffrés par enveloppe (une clé de données par élément,
-- enveloppée par la clé maîtresse ; voir vault/crypto.ts).

CREATE TABLE vault_items (
  id                 uuid PRIMARY KEY,                       -- choisi par le service avant le chiffrement (les données authentifiées le contiennent)
  owner_user_id      uuid REFERENCES users (id) ON DELETE CASCADE,
  owner_project_id   uuid REFERENCES projects (id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),   -- nom employé par les agents
  kind               text NOT NULL CHECK (kind IN ('ssh', 'postgres', 'website', 'google', 'api', 'secret')),
  description        text NOT NULL DEFAULT '',
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,     -- champs publics du type (en clair)
  secret_ciphertext  text,                                   -- "s1:<iv>:<tag>:<données>" : JSON des secrets, chiffré avec la clé de données
  wrapped_key        text,                                   -- "k1:<id de clé>:<iv>:<tag>:<données>" : clé de données enveloppée
  legacy_secrets     jsonb,                                  -- { champ: "v1:..." } repris des anciennes tables, convertis au démarrage puis NULL
  public_key         text,                                   -- ssh : clé publique de la paire
  host_key           text,                                   -- ssh : clé d'hôte mémorisée à la première connexion
  host_key_seen_at   timestamptz,
  read_only          boolean NOT NULL DEFAULT true,          -- postgres : transactions READ ONLY ; api : GET/HEAD/OPTIONS seulement
  require_approval   boolean NOT NULL DEFAULT true,          -- chaque usage par un agent est soumis à un humain
  command_allowlist  jsonb NOT NULL DEFAULT '[]'::jsonb,     -- ssh : préfixes de commandes autorisés (vide = tout)
  expires_at         timestamptz,                            -- rappel de rotation (indicatif)
  secret_updated_at  timestamptz,
  last_test_at       timestamptz,
  last_test_ok       boolean,
  last_test_error    text,
  created_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NULL) <> (owner_project_id IS NULL)),
  CHECK ((secret_ciphertext IS NULL) = (wrapped_key IS NULL))
);
CREATE UNIQUE INDEX vault_items_user_name_idx    ON vault_items (owner_user_id, name)    WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX vault_items_project_name_idx ON vault_items (owner_project_id, name) WHERE owner_project_id IS NOT NULL;
CREATE INDEX vault_items_google_sub_idx ON vault_items ((settings->>'googleSub')) WHERE kind = 'google';

-- Partage d'un élément avec une personne : use (voir et utiliser), read (aussi révéler les secrets), manage (tout).
CREATE TABLE vault_item_shares (
  item_id     uuid NOT NULL REFERENCES vault_items (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission  text NOT NULL CHECK (permission IN ('use', 'read', 'manage')),
  granted_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX vault_item_shares_user_idx ON vault_item_shares (user_id);

-- Lien d'un élément à un projet : pour tous ses agents (project) ou pour les seules sessions d'une personne (personal).
CREATE TABLE vault_item_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES vault_items (id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  scope       text NOT NULL CHECK (scope IN ('project', 'personal')),
  user_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  linked_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'personal') = (user_id IS NOT NULL))
);
CREATE UNIQUE INDEX vault_item_links_project_idx  ON vault_item_links (item_id, project_id)          WHERE scope = 'project';
CREATE UNIQUE INDEX vault_item_links_personal_idx ON vault_item_links (item_id, project_id, user_id) WHERE scope = 'personal';
CREATE INDEX vault_item_links_target_idx ON vault_item_links (project_id);

-- Journal (ajout seul, conservé 400 jours, survit à la suppression de l'élément).
CREATE TABLE vault_audit_events (
  id             bigserial PRIMARY KEY,
  item_id        uuid REFERENCES vault_items (id) ON DELETE SET NULL,
  item_name      text NOT NULL,
  item_kind      text NOT NULL,
  action         text NOT NULL,
  actor_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,   -- NULL : serveur / migration
  session_id     uuid,
  project_id     uuid,
  ok             boolean NOT NULL DEFAULT true,
  detail         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_audit_events_item_idx    ON vault_audit_events (item_id, created_at DESC);
CREATE INDEX vault_audit_events_created_idx ON vault_audit_events (created_at);

-- ---- Reprise des connexions : mêmes identifiants (les tunnels continuent de pointer juste) -------------
INSERT INTO vault_items (id, owner_project_id, name, kind, description, settings, legacy_secrets, public_key, host_key, host_key_seen_at,
                         read_only, require_approval, command_allowlist, secret_updated_at, last_test_at, last_test_ok, last_test_error, created_at, updated_at)
SELECT c.id, c.project_id, c.name, c.kind, c.description,
       CASE WHEN c.kind = 'postgres' THEN (c.settings - 'viaConnectionId') || jsonb_build_object('viaItemId', c.settings->'viaConnectionId') ELSE c.settings END,
       CASE WHEN c.secrets = '{}'::jsonb THEN NULL ELSE c.secrets END,
       c.public_key, c.host_key, c.host_key_seen_at, c.read_only, c.require_approval, c.command_allowlist,
       CASE WHEN c.secrets = '{}'::jsonb THEN NULL ELSE c.updated_at END,
       c.last_test_at, c.last_test_ok, c.last_test_error, c.created_at, c.updated_at
FROM connections c;

-- ---- Reprise des comptes Google des projets : éléments « google » --------------------------------------
WITH named AS (
  SELECT a.*,
         row_number() OVER (PARTITION BY a.project_id, lower(split_part(a.email, '@', 1)) ORDER BY a.created_at, a.id) AS rank,
         left(rtrim(regexp_replace(lower(split_part(a.email, '@', 1)), '[^a-z0-9_-]+', '-', 'g'), '-'), 33) AS base
  FROM project_google_accounts a
)
INSERT INTO vault_items (id, owner_project_id, name, kind, description, settings, legacy_secrets, read_only, require_approval,
                         secret_updated_at, last_test_at, last_test_ok, last_test_error, created_by, created_at, updated_at)
SELECT n.id, n.project_id,
       'google-' || CASE WHEN n.base = '' THEN 'compte' ELSE n.base END || CASE WHEN n.rank > 1 THEN '-' || n.rank ELSE '' END,
       'google', '',
       jsonb_build_object('email', n.email, 'displayName', n.name, 'avatarUrl', n.avatar_url, 'googleSub', n.google_sub,
                          'gmailAccess', n.gmail_access, 'driveAccess', n.drive_access, 'scopes', n.scopes),
       jsonb_build_object('refreshToken', n.refresh_token),
       false, true, n.updated_at, n.last_check_at, n.last_check_ok, n.last_check_error, n.connected_by, n.created_at, n.updated_at
FROM named n
ON CONFLICT (owner_project_id, name) WHERE owner_project_id IS NOT NULL DO NOTHING;

-- Comptes dont le nom calculé entrait en collision avec une connexion : nom dérivé de l'identifiant.
INSERT INTO vault_items (id, owner_project_id, name, kind, description, settings, legacy_secrets, read_only, require_approval,
                         secret_updated_at, last_test_at, last_test_ok, last_test_error, created_by, created_at, updated_at)
SELECT a.id, a.project_id, 'google-' || left(replace(a.id::text, '-', ''), 12), 'google', '',
       jsonb_build_object('email', a.email, 'displayName', a.name, 'avatarUrl', a.avatar_url, 'googleSub', a.google_sub,
                          'gmailAccess', a.gmail_access, 'driveAccess', a.drive_access, 'scopes', a.scopes),
       jsonb_build_object('refreshToken', a.refresh_token),
       false, true, a.updated_at, a.last_check_at, a.last_check_ok, a.last_check_error, a.connected_by, a.created_at, a.updated_at
FROM project_google_accounts a
WHERE NOT EXISTS (SELECT 1 FROM vault_items v WHERE v.id = a.id);

INSERT INTO vault_audit_events (item_id, item_name, item_kind, action, project_id, detail)
SELECT id, name, kind, 'migrated', owner_project_id, CASE WHEN kind = 'google' THEN 'Repris des comptes Google du projet' ELSE 'Repris des connexions du projet' END
FROM vault_items;

-- Autorisations mémorisées sur les anciens outils : mcp__connections… → mcp__vault…
UPDATE project_permission_rules r
SET tool_name = 'mcp__vault' || substr(r.tool_name, length('mcp__connections') + 1)
WHERE r.tool_name LIKE 'mcp\_\_connections%'
  AND NOT EXISTS (
    SELECT 1 FROM project_permission_rules x
    WHERE x.project_id = r.project_id
      AND x.tool_name = 'mcp__vault' || substr(r.tool_name, length('mcp__connections') + 1)
      AND COALESCE(x.rule_content, '') = COALESCE(r.rule_content, '')
  );
DELETE FROM project_permission_rules WHERE tool_name LIKE 'mcp\_\_connections%';

-- Anciennes tables conservées une version (retour arrière possible) ; une migration ultérieure les supprimera.
COMMENT ON TABLE connections IS 'Obsolète : remplacée par vault_items';
COMMENT ON TABLE project_google_accounts IS 'Obsolète : remplacée par vault_items (kind google)';
