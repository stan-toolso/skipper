-- Fichiers joints à une tâche (comment_id null) ou à l'un de ses commentaires (repris de Cockpit) : les
-- métadonnées ici, le contenu sur le disque du serveur (WORKSPACES_ROOT/.task-attachments/<tâche>/<id>/<nom>).
CREATE TABLE task_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  comment_id  uuid REFERENCES task_comments (id) ON DELETE CASCADE,
  name        text NOT NULL,
  media_type  text NOT NULL,
  size        integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_attachments_task_idx ON task_attachments (task_id, created_at);
CREATE INDEX task_attachments_comment_idx ON task_attachments (comment_id);
