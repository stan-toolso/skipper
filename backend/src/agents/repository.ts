import { toJson } from '../db/json.js';
import { pool } from '../db/pool.js';
import type { Agent, AgentRun, AgentRunFilter, AutomationSchedule, InputVariable, RunStatus, RunTrigger } from './types.js';

interface AgentRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  provider: string;
  config: Record<string, unknown> | null;
  system_prompt: string;
  prompt_template: string;
  inputs: InputVariable[] | null;
  output_format: 'text' | 'json';
  output_schema: string | null;
  worksession_id: string | null;
  timeout_minutes: number;
  cron: string | null;
  timezone: string;
  schedule_enabled: boolean;
  schedule_inputs: Record<string, unknown> | null;
  schedule_owner_id: string | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_result: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RunRow {
  id: string;
  agent_id: string;
  project_id: string;
  owner_id: string | null;
  session_id: string | null;
  workflow_run_id: string | null;
  node_key: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  inputs: Record<string, unknown> | null;
  prompt: string;
  output: string | null;
  output_json: unknown | null;
  error: string | null;
  cost_usd: string | number | null;
  duration_ms: number | null;
  heartbeat_at: Date;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Colonnes de planification partagées par les agents et les workflows. */
export const scheduleOf = (r: { cron: string | null; timezone: string; schedule_enabled: boolean; next_run_at: Date | null; last_run_at: Date | null; last_result: string | null }): AutomationSchedule | null =>
  r.cron ? { cron: r.cron, timezone: r.timezone, enabled: r.schedule_enabled, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastResult: r.last_result } : null;

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  description: r.description,
  provider: r.provider,
  config: r.config ?? {},
  systemPrompt: r.system_prompt,
  promptTemplate: r.prompt_template,
  inputs: r.inputs ?? [],
  outputFormat: r.output_format,
  outputSchema: r.output_schema,
  worksessionId: r.worksession_id,
  timeoutMinutes: r.timeout_minutes,
  schedule: scheduleOf(r),
  scheduleInputs: r.schedule_inputs ?? {},
  scheduleOwnerId: r.schedule_owner_id,
  createdById: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRun = (r: RunRow): AgentRun => ({
  id: r.id,
  agentId: r.agent_id,
  projectId: r.project_id,
  ownerId: r.owner_id,
  sessionId: r.session_id,
  workflowRunId: r.workflow_run_id,
  nodeKey: r.node_key,
  trigger: r.trigger,
  status: r.status,
  inputs: r.inputs ?? {},
  prompt: r.prompt,
  output: r.output,
  outputJson: r.output_json ?? null,
  error: r.error,
  costUsd: Number(r.cost_usd ?? 0),
  durationMs: r.duration_ms,
  heartbeatAt: r.heartbeat_at,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export interface AgentValues {
  name: string;
  description: string;
  provider: string;
  config: Record<string, unknown>;
  systemPrompt: string;
  promptTemplate: string;
  inputs: InputVariable[];
  outputFormat: 'text' | 'json';
  outputSchema: string | null;
  worksessionId: string | null;
  timeoutMinutes: number;
}

export interface ScheduleValues {
  cron: string | null;
  timezone: string;
  enabled: boolean;
  inputs: Record<string, unknown>;
  ownerId: string | null;
  nextRunAt: Date | null;
}

export interface RunPatch {
  status?: RunStatus;
  sessionId?: string | null;
  output?: string | null;
  outputJson?: unknown | null;
  error?: string | null;
  costUsd?: number;
  durationMs?: number | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  heartbeatAt?: Date;
}

const RUN_COLUMNS: Record<keyof RunPatch, { column: string; json?: boolean }> = {
  status: { column: 'status' },
  sessionId: { column: 'session_id' },
  output: { column: 'output' },
  outputJson: { column: 'output_json', json: true },
  error: { column: 'error' },
  costUsd: { column: 'cost_usd' },
  durationMs: { column: 'duration_ms' },
  startedAt: { column: 'started_at' },
  finishedAt: { column: 'finished_at' },
  heartbeatAt: { column: 'heartbeat_at' },
};

export const agentRepository = {
  async create(projectId: string, values: AgentValues, createdBy: string | null): Promise<Agent> {
    const { rows } = await pool.query<AgentRow>(
      `INSERT INTO agents (project_id, name, description, provider, config, system_prompt, prompt_template, inputs, output_format, output_schema, worksession_id, timeout_minutes, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $11, $12, $13) RETURNING *`,
      [projectId, values.name, values.description, values.provider, toJson(values.config), values.systemPrompt, values.promptTemplate, toJson(values.inputs), values.outputFormat, values.outputSchema, values.worksessionId, values.timeoutMinutes, createdBy],
    );
    return toAgent(rows[0]);
  },

  async update(id: string, values: AgentValues): Promise<Agent | null> {
    const { rows } = await pool.query<AgentRow>(
      `UPDATE agents SET name = $2, description = $3, provider = $4, config = $5::jsonb, system_prompt = $6, prompt_template = $7, inputs = $8::jsonb, output_format = $9,
         output_schema = $10, worksession_id = $11, timeout_minutes = $12, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, values.name, values.description, values.provider, toJson(values.config), values.systemPrompt, values.promptTemplate, toJson(values.inputs), values.outputFormat, values.outputSchema, values.worksessionId, values.timeoutMinutes],
    );
    return rows[0] ? toAgent(rows[0]) : null;
  },

  async findById(id: string): Promise<Agent | null> {
    const { rows } = await pool.query<AgentRow>('SELECT * FROM agents WHERE id = $1', [id]);
    return rows[0] ? toAgent(rows[0]) : null;
  },

  async list(filter: { projectId?: string; projectIds?: string[] } = {}): Promise<Agent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) where.push(`project_id = $${params.push(filter.projectId)}`);
    if (filter.projectIds) where.push(`project_id = ANY($${params.push(filter.projectIds)}::uuid[])`);
    const { rows } = await pool.query<AgentRow>(`SELECT * FROM agents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lower(name)`, params);
    return rows.map(toAgent);
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM agents WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  // ---- Planification ------------------------------------------------------------------------

  async setSchedule(id: string, values: ScheduleValues): Promise<Agent | null> {
    const { rows } = await pool.query<AgentRow>(
      `UPDATE agents SET cron = $2, timezone = $3, schedule_enabled = $4, schedule_inputs = $5::jsonb, schedule_owner_id = $6, next_run_at = $7, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, values.cron, values.timezone, values.enabled, toJson(values.inputs), values.ownerId, values.nextRunAt],
    );
    return rows[0] ? toAgent(rows[0]) : null;
  },

  async listScheduled(): Promise<Agent[]> {
    const { rows } = await pool.query<AgentRow>('SELECT * FROM agents WHERE schedule_enabled AND cron IS NOT NULL ORDER BY next_run_at');
    return rows.map(toAgent);
  },

  async listDue(now: Date): Promise<Agent[]> {
    const { rows } = await pool.query<AgentRow>('SELECT * FROM agents WHERE schedule_enabled AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at', [now]);
    return rows.map(toAgent);
  },

  /** Réserve une échéance : ne l'avance que si elle est encore celle qui a été lue (une seule instance l'exécute). */
  async claim(id: string, expectedNextRunAt: Date, nextRunAt: Date | null, now: Date): Promise<Agent | null> {
    const { rows } = await pool.query<AgentRow>(`UPDATE agents SET next_run_at = $3, last_run_at = $4, last_result = 'En cours', updated_at = now() WHERE id = $1 AND schedule_enabled AND next_run_at = $2 RETURNING *`, [id, expectedNextRunAt, nextRunAt, now]);
    return rows[0] ? toAgent(rows[0]) : null;
  },

  async setNextRunAt(id: string, nextRunAt: Date | null): Promise<void> {
    await pool.query('UPDATE agents SET next_run_at = $2, updated_at = now() WHERE id = $1', [id, nextRunAt]);
  },

  async setLastResult(id: string, result: string): Promise<void> {
    await pool.query('UPDATE agents SET last_result = $2, updated_at = now() WHERE id = $1', [id, result.slice(0, 500)]);
  },

  // ---- Exécutions -----------------------------------------------------------------------------

  async createRun(values: { agentId: string; projectId: string; ownerId: string | null; trigger: RunTrigger; inputs: Record<string, unknown>; prompt: string; workflowRunId?: string | null; nodeKey?: string | null }): Promise<AgentRun> {
    const { rows } = await pool.query<RunRow>(
      `INSERT INTO agent_runs (agent_id, project_id, owner_id, trigger, inputs, prompt, workflow_run_id, node_key) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING *`,
      [values.agentId, values.projectId, values.ownerId, values.trigger, toJson(values.inputs), values.prompt, values.workflowRunId ?? null, values.nodeKey ?? null],
    );
    return toRun(rows[0]);
  },

  async updateRun(id: string, patch: RunPatch): Promise<AgentRun | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, spec] of Object.entries(RUN_COLUMNS) as [keyof RunPatch, { column: string; json?: boolean }][]) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(spec.json ? (value === null ? null : toJson(value)) : value);
      sets.push(`${spec.column} = $${params.length}${spec.json ? '::jsonb' : ''}`);
    }
    if (!sets.length) return this.findRun(id);
    const { rows } = await pool.query<RunRow>(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toRun(rows[0]) : null;
  },

  async findRun(id: string): Promise<AgentRun | null> {
    const { rows } = await pool.query<RunRow>('SELECT * FROM agent_runs WHERE id = $1', [id]);
    return rows[0] ? toRun(rows[0]) : null;
  },

  async listRuns(filter: AgentRunFilter = {}): Promise<AgentRun[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.agentId) where.push(`agent_id = $${params.push(filter.agentId)}`);
    if (filter.projectId) where.push(`project_id = $${params.push(filter.projectId)}`);
    if (filter.projectIds) where.push(`project_id = ANY($${params.push(filter.projectIds)}::uuid[])`);
    if (filter.workflowRunId) where.push(`workflow_run_id = $${params.push(filter.workflowRunId)}`);
    if (filter.status?.length) where.push(`status = ANY($${params.push(filter.status)}::automation_run_status[])`);
    params.push(Math.min(filter.limit ?? 50, 500));
    const { rows } = await pool.query<RunRow>(`SELECT * FROM agent_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(toRun);
  },

  async lastRun(agentId: string): Promise<AgentRun | null> {
    const { rows } = await pool.query<RunRow>('SELECT * FROM agent_runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1', [agentId]);
    return rows[0] ? toRun(rows[0]) : null;
  },

  /** Exécutions actives dont le battement est plus vieux que `before` : perdues par un serveur arrêté. */
  async listStale(before: Date): Promise<AgentRun[]> {
    const { rows } = await pool.query<RunRow>("SELECT * FROM agent_runs WHERE status IN ('pending', 'running') AND heartbeat_at < $1", [before]);
    return rows.map(toRun);
  },
};
