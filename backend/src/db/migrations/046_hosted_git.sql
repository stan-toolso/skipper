-- Serveur git hébergé par Skipper, pour les projets qui n'ont pas de dépôt distant.
--
-- Un projet « hébergé » (git_hosted) a un dépôt nu sur le serveur (<WORKSPACES_ROOT>/.git-server/<slug>.git), servi en
-- smart HTTP sous /api/git/<slug>.git ; son git_url est dérivé de l'adresse de l'API et du slug, la colonne git_url
-- n'est alors pas lue (elle est remise à NULL).
ALTER TABLE projects ADD COLUMN git_hosted boolean NOT NULL DEFAULT false;

-- Jetons d'accès aux dépôts hébergés (mot de passe de l'authentification HTTP basic). Ils appartiennent à une personne et
-- valent pour tous les projets dont elle est membre (lecteur : lecture ; membre et administrateur : écriture).
-- `agent` : le jeton unique que Skipper transmet aux sessions et terminaux de la personne (gardé chiffré pour pouvoir
-- le redonner) ; `personal` : jetons créés par la personne pour ses propres clones, dont seul le hachage est conservé.
CREATE TABLE git_access_tokens (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('agent', 'personal')),
  label             text NOT NULL DEFAULT '',
  token_prefix      text NOT NULL,
  token_hash        text NOT NULL UNIQUE,
  token_ciphertext  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  expires_at        timestamptz,
  CONSTRAINT git_access_tokens_agent_secret CHECK ((kind = 'agent') = (token_ciphertext IS NOT NULL))
);
CREATE UNIQUE INDEX git_access_tokens_agent_idx ON git_access_tokens (user_id) WHERE kind = 'agent';
CREATE INDEX git_access_tokens_user_idx ON git_access_tokens (user_id);

-- Sauvegardes des dépôts hébergés : un bundle git complet (`git bundle create --all`) par prise, avec la liste des
-- références qu'il contient (pour ne pas sauvegarder deux fois le même état) et la branche de HEAD. Les dernières prises
-- sont conservées (voir gitServer/backups.ts) ; un dépôt dont le dossier a disparu est restauré depuis la plus récente.
CREATE TABLE git_repository_backups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  refs        text NOT NULL,
  head        text NOT NULL,
  bundle      bytea NOT NULL,
  size        bigint NOT NULL,
  taken_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX git_repository_backups_project_idx ON git_repository_backups (project_id, taken_at DESC);
