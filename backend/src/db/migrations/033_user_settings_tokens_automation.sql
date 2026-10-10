-- Réglages par utilisateur, jetons applicatifs du coffre, LiteLLM et Langfuse, comptes GitHub
-- par utilisateur, agents et workflows.

-- ---- Réglages d'un utilisateur (clé/valeur JSON) : claude, claude.verification, opencode, opencode.models...
CREATE TABLE user_settings (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- La consommation est attribuée au propriétaire de la session (plafond mensuel par personne).
ALTER TABLE usage_ledger ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX usage_ledger_user_idx ON usage_ledger (user_id, recorded_at DESC);
UPDATE usage_ledger l SET user_id = s.owner_id FROM sessions s WHERE s.id = l.session_id AND l.user_id IS NULL;

-- ---- Coffre : jetons applicatifs (Claude, fournisseurs OpenCode, GitHub), proxy LiteLLM, projet Langfuse.
ALTER TABLE vault_items DROP CONSTRAINT vault_items_kind_check;
ALTER TABLE vault_items ADD CONSTRAINT vault_items_kind_check
  CHECK (kind IN ('ssh', 'postgres', 'website', 'google', 'api', 'secret', 'token', 'litellm', 'langfuse'));

-- ---- Comptes GitHub d'un utilisateur (plusieurs possibles) ; le jeton vit dans l'élément du coffre.
CREATE TABLE user_github_accounts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  login                     text NOT NULL,
  avatar_url                text,
  method                    text NOT NULL CHECK (method IN ('oauth', 'pat')),
  vault_item_id             uuid NOT NULL REFERENCES vault_items (id) ON DELETE CASCADE,
  token_expires_at          timestamptz,
  refresh_token_expires_at  timestamptz,
  scopes                    text[] NOT NULL DEFAULT '{}',
  -- Organisations du compte (lues à la connexion), pour choisir le compte d'après le propriétaire du dépôt.
  organizations             text[] NOT NULL DEFAULT '{}',
  is_default                boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_github_accounts_login_idx ON user_github_accounts (user_id, lower(login));
CREATE UNIQUE INDEX user_github_accounts_default_idx ON user_github_accounts (user_id) WHERE is_default;

-- ---- Agents : configurations réutilisables, exécutées à la main, par planification ou comme étape d'un workflow.
CREATE TYPE automation_run_status AS ENUM ('queued', 'pending', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE automation_run_trigger AS ENUM ('manual', 'schedule', 'workflow', 'test', 'event');

CREATE TABLE agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  provider          text NOT NULL,                        -- llm (appel direct au modèle), claude, opencode, shell
  config            jsonb NOT NULL DEFAULT '{}',          -- réglages du modèle ou de la session
  system_prompt     text NOT NULL DEFAULT '',
  prompt_template   text NOT NULL DEFAULT '',             -- instruction envoyée à chaque exécution, avec {{input.<clé>}}
  inputs            jsonb NOT NULL DEFAULT '[]',          -- variables déclarées [{key, label, description, required, defaultValue}]
  output_format     text NOT NULL DEFAULT 'text' CHECK (output_format IN ('text', 'json')),
  output_schema     text,
  worktree_id       uuid REFERENCES worktrees (id) ON DELETE SET NULL,
  timeout_minutes   integer NOT NULL DEFAULT 60,
  cron              text,
  timezone          text NOT NULL DEFAULT 'UTC',
  schedule_enabled  boolean NOT NULL DEFAULT false,
  schedule_inputs   jsonb NOT NULL DEFAULT '{}',
  schedule_owner_id uuid REFERENCES users (id) ON DELETE SET NULL,
  next_run_at       timestamptz,
  last_run_at       timestamptz,
  last_result       text,
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_project_idx ON agents (project_id, name);
CREATE INDEX agents_due_idx ON agents (next_run_at) WHERE schedule_enabled AND next_run_at IS NOT NULL;

-- ---- Workflows : un graphe de nœuds (déclencheur, agent, tâche, session, création de tâche, condition, fin).
CREATE TABLE workflows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  definition        jsonb NOT NULL DEFAULT '{"nodes": [], "edges": []}',
  enabled           boolean NOT NULL DEFAULT true,
  cron              text,
  timezone          text NOT NULL DEFAULT 'UTC',
  schedule_enabled  boolean NOT NULL DEFAULT false,
  schedule_inputs   jsonb NOT NULL DEFAULT '{}',
  schedule_owner_id uuid REFERENCES users (id) ON DELETE SET NULL,
  event_owner_id    uuid REFERENCES users (id) ON DELETE SET NULL,   -- comptes des exécutions déclenchées par un événement
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_project_idx ON workflows (project_id, name);
CREATE INDEX workflows_due_idx ON workflows (next_run_at) WHERE schedule_enabled AND next_run_at IS NOT NULL;

CREATE TABLE workflow_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id       uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_id          uuid REFERENCES users (id) ON DELETE SET NULL,
  trigger           automation_run_trigger NOT NULL,
  trigger_key       text,                                 -- nœud déclencheur de départ
  status            automation_run_status NOT NULL DEFAULT 'pending',
  definition        jsonb NOT NULL,                       -- graphe figé au lancement
  inputs            jsonb NOT NULL DEFAULT '{}',
  output            jsonb,
  error             text,
  cost_usd          numeric(12, 6) NOT NULL DEFAULT 0,
  cancel_requested  boolean NOT NULL DEFAULT false,
  heartbeat_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);
CREATE INDEX workflow_runs_workflow_idx ON workflow_runs (workflow_id, created_at DESC);
CREATE INDEX workflow_runs_project_idx ON workflow_runs (project_id, created_at DESC);
CREATE INDEX workflow_runs_active_idx ON workflow_runs (status) WHERE status IN ('queued', 'pending', 'running');

CREATE TABLE agent_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  session_id       uuid REFERENCES sessions (id) ON DELETE SET NULL,
  workflow_run_id  uuid REFERENCES workflow_runs (id) ON DELETE SET NULL,
  node_key         text,
  trigger          automation_run_trigger NOT NULL,
  status           automation_run_status NOT NULL DEFAULT 'pending',
  inputs           jsonb NOT NULL DEFAULT '{}',
  prompt           text NOT NULL DEFAULT '',
  output           text,
  output_json      jsonb,
  error            text,
  cost_usd         numeric(12, 6) NOT NULL DEFAULT 0,
  duration_ms      integer,
  heartbeat_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE INDEX agent_runs_agent_idx ON agent_runs (agent_id, created_at DESC);
CREATE INDEX agent_runs_project_idx ON agent_runs (project_id, created_at DESC);
CREATE INDEX agent_runs_workflow_run_idx ON agent_runs (workflow_run_id);
CREATE INDEX agent_runs_active_idx ON agent_runs (status) WHERE status IN ('pending', 'running');

CREATE TABLE workflow_run_nodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  node_key      text NOT NULL,
  node_type     text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
  input         jsonb,
  output        jsonb,
  error         text,
  agent_run_id  uuid REFERENCES agent_runs (id) ON DELETE SET NULL,
  started_at    timestamptz,
  finished_at   timestamptz,
  UNIQUE (run_id, node_key)
);

CREATE TABLE workflow_run_logs (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  node_key    text,
  level       text NOT NULL DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message     text NOT NULL,
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_run_logs_run_idx ON workflow_run_logs (run_id, id);

-- Une session lancée par une exécution d'agent ou de workflow connaît son origine.
ALTER TABLE sessions ADD COLUMN agent_id uuid REFERENCES agents (id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN agent_run_id uuid REFERENCES agent_runs (id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN workflow_run_id uuid REFERENCES workflow_runs (id) ON DELETE SET NULL;
CREATE INDEX sessions_agent_idx ON sessions (agent_id) WHERE agent_id IS NOT NULL;

-- ---- Sessions OpenCode : miroir de la conversation (la base locale d'OpenCode vit dans le conteneur).
CREATE TABLE opencode_sessions (
  session_id           uuid PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  opencode_session_id  text NOT NULL,
  info                 jsonb NOT NULL,
  messages             jsonb NOT NULL DEFAULT '[]',
  updated_at           timestamptz NOT NULL DEFAULT now()
);
