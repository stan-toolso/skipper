-- Tâches d'un projet, avec priorité ; créées et mises à jour par les humains ou les agents.
CREATE TYPE task_status AS ENUM ('todo', 'in_progress', 'done', 'cancelled');
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'urgent');

CREATE TABLE tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title                 text NOT NULL,
  description           text NOT NULL DEFAULT '',
  status                task_status NOT NULL DEFAULT 'todo',
  priority              task_priority NOT NULL DEFAULT 'medium',
  -- Session d'agent qui s'en occupe (optionnel).
  session_id            uuid REFERENCES sessions (id) ON DELETE SET NULL,
  created_by_type       text NOT NULL CHECK (created_by_type IN ('human', 'agent')),
  created_by_session_id uuid REFERENCES sessions (id) ON DELETE SET NULL,
  due_date              date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz
);
CREATE INDEX tasks_project_idx ON tasks (project_id, status, priority);
