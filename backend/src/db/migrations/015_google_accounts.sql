-- Compte Google relié à un projet (OAuth) pour donner aux agents accès à la messagerie (Gmail) et/ou
-- au Drive de ce compte. Un seul compte par projet. Le jeton de rafraîchissement est chiffré
-- (AES-256-GCM, voir settings/crypto.ts) ; les jetons d'accès ne vivent qu'en mémoire.
CREATE TABLE project_google_accounts (
  project_id       uuid PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  email            text NOT NULL,
  name             text,
  avatar_url       text,
  google_sub       text NOT NULL,
  gmail_access     text NOT NULL DEFAULT 'none' CHECK (gmail_access IN ('none', 'read', 'write')),
  drive_access     text NOT NULL DEFAULT 'none' CHECK (drive_access IN ('none', 'read', 'write')),
  scopes           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- portées effectivement accordées par Google
  refresh_token    text NOT NULL,                        -- chiffré
  connected_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  last_check_at    timestamptz,
  last_check_ok    boolean,
  last_check_error text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
