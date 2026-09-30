-- Notifications réservées aux administrateurs de l'application (ex. limites d'utilisation de Claude) :
-- elles ne portent sur aucun projet mais ne doivent pas apparaître chez les autres utilisateurs.
ALTER TABLE notifications ADD COLUMN admins_only boolean NOT NULL DEFAULT false;
