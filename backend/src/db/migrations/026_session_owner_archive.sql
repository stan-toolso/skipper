-- Propriétaire des sessions (qui les a lancées) et archivage des sessions.

-- Utilisateur qui a lancé la session ; une session lancée par un agent hérite du propriétaire de sa session
-- parente. NULL : session d'avant cette version, ou lancée par le serveur (planification), ouverte à tous les membres.
ALTER TABLE sessions ADD COLUMN owner_id uuid REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX sessions_owner_idx ON sessions (owner_id);

-- Archivée : cachée des listes actives, historique conservé, consultable et relançable depuis l'historique du projet.
ALTER TABLE sessions ADD COLUMN archived_at timestamptz;
CREATE INDEX sessions_archived_idx ON sessions (project_id, archived_at DESC) WHERE archived_at IS NOT NULL;

-- Notification adressée à une seule personne (session partagée, page partagée...) : visible par elle seule.
ALTER TABLE notifications ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE CASCADE;
CREATE INDEX notifications_user_idx ON notifications (user_id) WHERE user_id IS NOT NULL;

-- Qui a répondu à une demande.
ALTER TABLE requests ADD COLUMN answered_by uuid REFERENCES users (id) ON DELETE SET NULL;
