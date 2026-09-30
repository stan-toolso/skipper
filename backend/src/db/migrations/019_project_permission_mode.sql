-- Mode d'autorisation appliqué aux nouvelles sessions du projet qui n'en précisent pas (sessions de tâches,
-- sessions planifiées, préremplissage du formulaire de session).
ALTER TABLE projects ADD COLUMN default_permission_mode text NOT NULL DEFAULT 'default'
  CHECK (default_permission_mode IN ('default', 'acceptEdits', 'bypassPermissions', 'plan'));
