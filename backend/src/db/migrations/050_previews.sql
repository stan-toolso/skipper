-- Aperçu en direct d'une work session : le serveur de développement de la branche, lancé dans le conteneur du projet
-- et servi par Skipper sur un sous-domaine (`<host_label>.<domaine des aperçus>`). L'état du processus (installation,
-- démarrage, arrêt) vit dans le dossier `.skipper-previews/<work session>/` à côté des work sessions, lisible de toutes
-- les instances : cette table ne garde que ce qui doit rester stable d'un lancement à l'autre (nom d'hôte, port).
CREATE TABLE previews (
  worksession_id  uuid PRIMARY KEY REFERENCES worksessions (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  host_label      text NOT NULL UNIQUE,
  port            integer NOT NULL,
  started_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  started_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, port)
);

-- Accès à un aperçu : `grant` est un lien à usage unique et de courte durée (iframe du panneau, QR code pour un
-- téléphone), échangé contre un `access` (cookie du sous-domaine de l'aperçu, quelques heures). Seule l'empreinte
-- SHA-256 du jeton est gardée.
CREATE TABLE preview_access (
  token_hash      text PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('grant', 'access')),
  worksession_id  uuid NOT NULL REFERENCES previews (worksession_id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX preview_access_expires_idx ON preview_access (expires_at);
