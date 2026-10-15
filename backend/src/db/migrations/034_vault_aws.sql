-- Coffre : comptes AWS (IAM Identity Center par connexion par code, ou clés d'accès), utilisés par les
-- agents à travers l'outil aws_run (CLI AWS exécuté par le serveur dans un conteneur jetable).
ALTER TABLE vault_items DROP CONSTRAINT vault_items_kind_check;
ALTER TABLE vault_items ADD CONSTRAINT vault_items_kind_check
  CHECK (kind IN ('ssh', 'postgres', 'website', 'google', 'api', 'secret', 'aws', 'token', 'litellm', 'langfuse'));
