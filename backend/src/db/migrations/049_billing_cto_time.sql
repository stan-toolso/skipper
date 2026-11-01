-- Facturation de la cellule : temps passé par un CTO Toolso pour le client, saisi par un super administrateur
-- (Toolso) et facturé au tarif journalier des réglages `billing` (app_settings). L'abonnement et l'usage des
-- agents se calculent à partir des projets et de usage_ledger : rien d'autre à stocker.
CREATE TABLE cto_time_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day          date NOT NULL,
  hours        numeric(6, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  project_id   uuid REFERENCES projects (id) ON DELETE SET NULL,
  description  text NOT NULL DEFAULT '',
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cto_time_entries_day_idx ON cto_time_entries (day);
