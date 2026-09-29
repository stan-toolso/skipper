-- Configuration générale de l'application (clé/valeur JSON) et relevé de consommation Claude.

CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Coût cumulé connu d'une session (dernier total_cost_usd rapporté par le SDK), pour calculer les deltas.
ALTER TABLE sessions ADD COLUMN cost_usd numeric(12, 6) NOT NULL DEFAULT 0;

-- Une ligne par tour facturé : delta de coût estimé, ventilé par session.
CREATE TABLE usage_ledger (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid REFERENCES sessions (id) ON DELETE SET NULL,
  project_id   uuid REFERENCES projects (id) ON DELETE SET NULL,
  models       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { "<modèle>": coût du delta attribué }
  cost_usd     numeric(12, 6) NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_recorded_idx ON usage_ledger (recorded_at DESC);
