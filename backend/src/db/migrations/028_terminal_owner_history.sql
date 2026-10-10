-- Terminaux : propriétaire et historique des commandes.

-- Utilisateur qui a ouvert le terminal : seul lui le voit et s'y attache. NULL : terminal d'avant cette version.
ALTER TABLE terminals ADD COLUMN created_by uuid REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX terminals_created_by_idx ON terminals (created_by);

-- Historique des commandes du shell, par projet et par utilisateur : chargé dans chaque nouveau terminal
-- (flèche haut, Ctrl+R) et complété à la fermeture et toutes les 30 secondes. Au plus 5000 lignes.
CREATE TABLE terminal_histories (
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  lines      text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX terminal_histories_user_idx ON terminal_histories (user_id);
