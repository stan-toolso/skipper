-- Autorisations d'outils mémorisées au niveau d'un projet (« ne plus demander dans ce projet »).
-- Chaque ligne est une règle de permission Claude Code : outil seul (Read) ou outil avec motif (Bash(git status:*)).
CREATE TABLE project_permission_rules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  tool_name              text NOT NULL,
  rule_content           text,                      -- null : tout l'outil
  created_by_session_id  uuid REFERENCES sessions (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX project_permission_rules_unique ON project_permission_rules (project_id, tool_name, COALESCE(rule_content, ''));
