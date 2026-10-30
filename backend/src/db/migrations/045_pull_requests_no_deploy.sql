-- Pull requests suivies : plus d'étape « déployée ». Le déploiement n'était qu'une déclaration manuelle, rarement tenue
-- à jour ; une PR fusionnée est désormais au bout de son suivi. Les colonnes du déploiement disparaissent.
DROP INDEX IF EXISTS pull_requests_project_status_idx;
ALTER TABLE pull_requests
  DROP COLUMN deployed_at,
  DROP COLUMN deployed_by_type,
  DROP COLUMN deployed_by_user_id,
  DROP COLUMN deployed_by_session_id,
  DROP COLUMN deploy_note;
CREATE INDEX pull_requests_project_status_idx ON pull_requests (project_id, status);
