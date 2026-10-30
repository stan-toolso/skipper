-- Coffre : comptes Scaleway (clé d'API IAM), utilisés par les agents à travers les outils scw_run (CLI scw
-- exécuté par le serveur dans un conteneur jetable) et scw_api (API HTTP api.scaleway.com, authentifiée par le serveur).
ALTER TABLE vault_items DROP CONSTRAINT vault_items_kind_check;
ALTER TABLE vault_items ADD CONSTRAINT vault_items_kind_check
  CHECK (kind IN ('ssh', 'postgres', 'website', 'google', 'api', 'secret', 'aws', 'scaleway', 'token', 'litellm', 'langfuse'));
