-- Connexions d'un projet vers des systèmes externes (serveur SSH, base PostgreSQL...), utilisables
-- par les agents. Les champs publics (hôte, port, utilisateur...) sont en clair dans `settings` ;
-- les secrets (clé privée, mot de passe) sont chiffrés (AES-256-GCM, voir settings/crypto.ts) dans `secrets`.
CREATE TABLE connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name              text NOT NULL,                       -- identifiant court utilisé par les agents (ex. "prod")
  kind              text NOT NULL,                       -- ssh | postgres
  description       text NOT NULL DEFAULT '',
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- champs publics propres au type
  secrets           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { privateKey | password: "<chiffré>" }
  public_key        text,                                -- ssh : clé publique de la paire générée par Skipper
  host_key          text,                                -- ssh : clé d'hôte mémorisée à la première connexion ("type base64")
  host_key_seen_at  timestamptz,
  -- Politique d'accès des agents.
  exposure          text NOT NULL DEFAULT 'mcp',         -- mcp (outils courtiers) | direct (ssh/psql dans le shell) | both
  read_only         boolean NOT NULL DEFAULT true,       -- postgres : transactions en lecture seule
  require_approval  boolean NOT NULL DEFAULT true,       -- chaque appel d'outil est soumis à l'humain
  command_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ssh : préfixes de commandes autorisés (vide = tout)
  -- Dernier test de connexion depuis l'interface.
  last_test_at      timestamptz,
  last_test_ok      boolean,
  last_test_error   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX connections_project_idx ON connections (project_id);
