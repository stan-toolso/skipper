-- Pull requests suivies : l'objet qui matérialise une PR GitHub dans Skipper, rattaché à un projet et, le plus
-- souvent, à une tâche. Créé par une session d'agent (outils tasks.pr_open / pr_register), par l'interface
-- (création ou suivi d'une PR, panneau git) ou par la synchronisation avec GitHub (PR ouverte sur la branche
-- d'une tâche). Son statut (ouverte, fusionnée, fermée) et son instantané GitHub (checks, revue, conflits) sont
-- rafraîchis à la synchronisation ; le déploiement est noté à part (deployed_at) pour suivre « à déployer ».
CREATE TABLE pull_requests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  task_id                 uuid REFERENCES tasks (id) ON DELETE SET NULL,
  number                  integer NOT NULL,
  url                     text NOT NULL,
  title                   text NOT NULL,
  head_branch             text NOT NULL,
  base_branch             text NOT NULL DEFAULT '',
  status                  text NOT NULL CHECK (status IN ('open', 'merged', 'closed')),
  is_draft                boolean NOT NULL DEFAULT false,
  -- Instantané GitHub du dernier rafraîchissement (null tant que GitHub n'a pas été interrogé).
  checks_state            text,          -- SUCCESS, FAILURE, PENDING, ERROR, EXPECTED
  review_decision         text,          -- APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED
  mergeable               text,          -- MERGEABLE, CONFLICTING, UNKNOWN
  synced_at               timestamptz,
  merge_sha               text,
  -- Mise en production de la PR fusionnée (humain ou agent), avec une note libre (version, cellule...).
  deployed_at             timestamptz,
  deployed_by_type        text CHECK (deployed_by_type IN ('human', 'agent')),
  deployed_by_user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  deployed_by_session_id  uuid REFERENCES sessions (id) ON DELETE SET NULL,
  deploy_note             text NOT NULL DEFAULT '',
  -- Note libre tenue par l'agent ou les personnes (« attend la CI », « revue demandée à X »...).
  note                    text NOT NULL DEFAULT '',
  created_by_type         text NOT NULL CHECK (created_by_type IN ('human', 'agent', 'system')),
  created_by_user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_session_id   uuid REFERENCES sessions (id) ON DELETE SET NULL,
  opened_at               timestamptz NOT NULL DEFAULT now(),   -- ouverture sur GitHub
  merged_at               timestamptz,
  closed_at               timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);
CREATE INDEX pull_requests_task_idx ON pull_requests (task_id);
CREATE INDEX pull_requests_project_status_idx ON pull_requests (project_id, status, deployed_at);
CREATE INDEX pull_requests_session_idx ON pull_requests (created_by_session_id);
