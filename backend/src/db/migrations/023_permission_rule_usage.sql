-- Utilisation des autorisations mémorisées : date de la dernière utilisation et nombre d'appels d'outils
-- autorisés par la règle, relevés par le provider. usage_tracked_since date le début du suivi (la migration
-- pour les règles existantes) : une règle sans utilisation depuis est candidate au retrait.
ALTER TABLE project_permission_rules
  ADD COLUMN last_used_at        timestamptz,
  ADD COLUMN use_count           integer NOT NULL DEFAULT 0,
  ADD COLUMN usage_tracked_since timestamptz NOT NULL DEFAULT now();
