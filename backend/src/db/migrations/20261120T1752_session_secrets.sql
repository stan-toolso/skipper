-- Secrets éphémères d'une session (vault.request_secrets, « pour cette session seulement ») : saisis par une personne,
-- chiffrés comme le coffre (clé de données par secret, enveloppée par la clé maîtresse), jamais rangés dans le coffre.
-- Effacés à l'archivage de la session, à sa suppression (cascade) ou à expiration (purge par l'instance meneuse).
CREATE TABLE session_secrets (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  name text NOT NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  secret_ciphertext text NOT NULL,
  wrapped_key text NOT NULL,
  require_approval boolean NOT NULL DEFAULT true,
  created_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (session_id, name)
);

CREATE INDEX session_secrets_expires_idx ON session_secrets (expires_at);
