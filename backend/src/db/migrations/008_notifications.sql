-- Notifications affichées dans l'interface (cloche) : nouvelle demande, tâche créée par un agent, etc.
CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  type        text NOT NULL,                -- request.created, task.created, task.completed, session.completed, session.failed, context.created...
  title       text NOT NULL,
  message     text,
  link        text,                         -- chemin dans l'application, ex. /sessions/<id>
  project_id  uuid REFERENCES projects (id) ON DELETE CASCADE,
  session_id  uuid REFERENCES sessions (id) ON DELETE CASCADE,
  payload     jsonb NOT NULL DEFAULT '{}',
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_unread_idx ON notifications (created_at DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_created_idx ON notifications (created_at DESC);
