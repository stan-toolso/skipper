import { toJson } from '../db/json.js';
import { pool } from '../db/pool.js';
import type { AutomationSchedule, LogLevel, NodeRunStatus, RunStatus, RunTrigger, Workflow, WorkflowDefinition, WorkflowNodeType, WorkflowRun, WorkflowRunFilter, WorkflowRunLog, WorkflowRunNode } from './types.js';

/** Colonnes de planification d'un workflow. */
const scheduleOf = (r: { cron: string | null; timezone: string; schedule_enabled: boolean; next_run_at: Date | null; last_run_at: Date | null; last_result: string | null }): AutomationSchedule | null =>
  r.cron ? { cron: r.cron, timezone: r.timezone, enabled: r.schedule_enabled, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastResult: r.last_result } : null;

interface WorkflowRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  definition: WorkflowDefinition | null;
  enabled: boolean;
  cron: string | null;
  timezone: string;
  schedule_enabled: boolean;
  schedule_inputs: Record<string, unknown> | null;
  schedule_owner_id: string | null;
  event_owner_id: string | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_result: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RunRow {
  id: string;
  workflow_id: string;
  project_id: string;
  owner_id: string | null;
  trigger: RunTrigger;
  trigger_key: string | null;
  status: RunStatus;
  definition: WorkflowDefinition;
  inputs: Record<string, unknown> | null;
  output: unknown | null;
  error: string | null;
  cost_usd: string | number | null;
  cancel_requested: boolean;
  heartbeat_at: Date;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

interface NodeRow {
  id: string;
  run_id: string;
  node_key: string;
  node_type: WorkflowNodeType;
  status: NodeRunStatus;
  input: unknown | null;
  output: unknown | null;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

interface LogRow {
  id: string;
  run_id: string;
  node_key: string | null;
  level: LogLevel;
  message: string;
  data: unknown | null;
  created_at: Date;
}

const toWorkflow = (r: WorkflowRow): Workflow => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  description: r.description,
  definition: r.definition ?? { nodes: [], edges: [] },
  enabled: r.enabled,
  schedule: scheduleOf(r),
  scheduleInputs: r.schedule_inputs ?? {},
  scheduleOwnerId: r.schedule_owner_id,
  eventOwnerId: r.event_owner_id ?? null,
  createdById: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRun = (r: RunRow): WorkflowRun => ({
  id: r.id,
  workflowId: r.workflow_id,
  projectId: r.project_id,
  ownerId: r.owner_id,
  trigger: r.trigger,
  triggerKey: r.trigger_key ?? null,
  status: r.status,
  definition: r.definition,
  inputs: r.inputs ?? {},
  output: r.output ?? null,
  error: r.error,
  costUsd: Number(r.cost_usd ?? 0),
  cancelRequested: r.cancel_requested,
  heartbeatAt: r.heartbeat_at,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const toNode = (r: NodeRow): WorkflowRunNode => ({ id: r.id, runId: r.run_id, nodeKey: r.node_key, nodeType: r.node_type, status: r.status, input: r.input ?? null, output: r.output ?? null, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at });
const toLog = (r: LogRow): WorkflowRunLog => ({ id: String(r.id), runId: r.run_id, nodeKey: r.node_key, level: r.level, message: r.message, data: r.data ?? null, createdAt: r.created_at });

export interface WorkflowValues {
  name: string;
  description: string;
  definition: WorkflowDefinition;
  enabled: boolean;
  eventOwnerId: string | null;
}

export interface WorkflowScheduleValues {
  cron: string | null;
  timezone: string;
  enabled: boolean;
  inputs: Record<string, unknown>;
  ownerId: string | null;
  nextRunAt: Date | null;
}

export interface RunPatch {
  status?: RunStatus;
  output?: unknown | null;
  error?: string | null;
  costUsd?: number;
  cancelRequested?: boolean;
  heartbeatAt?: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export interface NodePatch {
  status?: NodeRunStatus;
  input?: unknown | null;
  output?: unknown | null;
  error?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

const RUN_COLUMNS: Record<keyof RunPatch, { column: string; json?: boolean }> = {
  status: { column: 'status' },
  output: { column: 'output', json: true },
  error: { column: 'error' },
  costUsd: { column: 'cost_usd' },
  cancelRequested: { column: 'cancel_requested' },
  heartbeatAt: { column: 'heartbeat_at' },
  startedAt: { column: 'started_at' },
  finishedAt: { column: 'finished_at' },
};

export const workflowRepository = {
  async create(projectId: string, values: WorkflowValues, createdBy: string | null): Promise<Workflow> {
    const { rows } = await pool.query<WorkflowRow>(`INSERT INTO workflows (project_id, name, description, definition, enabled, event_owner_id, created_by) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING *`, [projectId, values.name, values.description, toJson(values.definition), values.enabled, values.eventOwnerId, createdBy]);
    return toWorkflow(rows[0]);
  },

  async update(id: string, values: WorkflowValues): Promise<Workflow | null> {
    const { rows } = await pool.query<WorkflowRow>(`UPDATE workflows SET name = $2, description = $3, definition = $4::jsonb, enabled = $5, event_owner_id = $6, updated_at = now() WHERE id = $1 RETURNING *`, [id, values.name, values.description, toJson(values.definition), values.enabled, values.eventOwnerId]);
    return rows[0] ? toWorkflow(rows[0]) : null;
  },

  async findById(id: string): Promise<Workflow | null> {
    const { rows } = await pool.query<WorkflowRow>('SELECT * FROM workflows WHERE id = $1', [id]);
    return rows[0] ? toWorkflow(rows[0]) : null;
  },

  async list(filter: { projectId?: string; projectIds?: string[] } = {}): Promise<Workflow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) where.push(`project_id = $${params.push(filter.projectId)}`);
    if (filter.projectIds) where.push(`project_id = ANY($${params.push(filter.projectIds)}::uuid[])`);
    const { rows } = await pool.query<WorkflowRow>(`SELECT * FROM workflows ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lower(name)`, params);
    return rows.map(toWorkflow);
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM workflows WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  // ---- Planification ------------------------------------------------------------------------

  async setSchedule(id: string, values: WorkflowScheduleValues): Promise<Workflow | null> {
    const { rows } = await pool.query<WorkflowRow>(`UPDATE workflows SET cron = $2, timezone = $3, schedule_enabled = $4, schedule_inputs = $5::jsonb, schedule_owner_id = $6, next_run_at = $7, updated_at = now() WHERE id = $1 RETURNING *`, [id, values.cron, values.timezone, values.enabled, toJson(values.inputs), values.ownerId, values.nextRunAt]);
    return rows[0] ? toWorkflow(rows[0]) : null;
  },

  async listScheduled(): Promise<Workflow[]> {
    const { rows } = await pool.query<WorkflowRow>('SELECT * FROM workflows WHERE schedule_enabled AND cron IS NOT NULL ORDER BY next_run_at');
    return rows.map(toWorkflow);
  },

  async listDue(now: Date): Promise<Workflow[]> {
    const { rows } = await pool.query<WorkflowRow>('SELECT * FROM workflows WHERE schedule_enabled AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at', [now]);
    return rows.map(toWorkflow);
  },

  async claim(id: string, expectedNextRunAt: Date, nextRunAt: Date | null, now: Date): Promise<Workflow | null> {
    const { rows } = await pool.query<WorkflowRow>(`UPDATE workflows SET next_run_at = $3, last_run_at = $4, last_result = 'En cours', updated_at = now() WHERE id = $1 AND schedule_enabled AND next_run_at = $2 RETURNING *`, [id, expectedNextRunAt, nextRunAt, now]);
    return rows[0] ? toWorkflow(rows[0]) : null;
  },

  async setNextRunAt(id: string, nextRunAt: Date | null): Promise<void> {
    await pool.query('UPDATE workflows SET next_run_at = $2, updated_at = now() WHERE id = $1', [id, nextRunAt]);
  },

  async setLastResult(id: string, result: string): Promise<void> {
    await pool.query('UPDATE workflows SET last_result = $2, updated_at = now() WHERE id = $1', [id, result.slice(0, 500)]);
  },

  // ---- Exécutions -----------------------------------------------------------------------------

  async createRun(values: { workflowId: string; projectId: string; ownerId: string | null; trigger: RunTrigger; triggerKey: string | null; definition: WorkflowDefinition; inputs: Record<string, unknown>; status?: 'pending' | 'queued' }): Promise<WorkflowRun> {
    const { rows } = await pool.query<RunRow>(`INSERT INTO workflow_runs (workflow_id, project_id, owner_id, trigger, trigger_key, definition, inputs, status) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) RETURNING *`, [
      values.workflowId,
      values.projectId,
      values.ownerId,
      values.trigger,
      values.triggerKey,
      toJson(values.definition),
      toJson(values.inputs),
      values.status ?? 'pending',
    ]);
    return toRun(rows[0]);
  },

  async updateRun(id: string, patch: RunPatch): Promise<WorkflowRun | null> {
    const params: unknown[] = [id];
    const sets: string[] = [];
    for (const [key, spec] of Object.entries(RUN_COLUMNS) as [keyof RunPatch, { column: string; json?: boolean }][]) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(spec.json ? (value === null ? null : toJson(value)) : value);
      sets.push(`${spec.column} = $${params.length}${spec.json ? '::jsonb' : ''}`);
    }
    if (!sets.length) return this.findRun(id);
    const { rows } = await pool.query<RunRow>(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toRun(rows[0]) : null;
  },

  async findRun(id: string): Promise<WorkflowRun | null> {
    const { rows } = await pool.query<RunRow>('SELECT * FROM workflow_runs WHERE id = $1', [id]);
    return rows[0] ? toRun(rows[0]) : null;
  },

  async listRuns(filter: WorkflowRunFilter = {}): Promise<WorkflowRun[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.workflowId) where.push(`workflow_id = $${params.push(filter.workflowId)}`);
    if (filter.projectId) where.push(`project_id = $${params.push(filter.projectId)}`);
    if (filter.projectIds) where.push(`project_id = ANY($${params.push(filter.projectIds)}::uuid[])`);
    if (filter.status?.length) where.push(`status = ANY($${params.push(filter.status)}::automation_run_status[])`);
    params.push(Math.min(filter.limit ?? 50, 500));
    const { rows } = await pool.query<RunRow>(`SELECT * FROM workflow_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(toRun);
  },

  async lastRun(workflowId: string): Promise<WorkflowRun | null> {
    const { rows } = await pool.query<RunRow>('SELECT * FROM workflow_runs WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT 1', [workflowId]);
    return rows[0] ? toRun(rows[0]) : null;
  },

  async countActive(workflowId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM workflow_runs WHERE workflow_id = $1 AND status IN ('pending', 'running')", [workflowId]);
    return Number(rows[0]?.n ?? 0);
  },

  /** Sort la plus ancienne exécution en file d'un workflow (elle devient pending) ; null quand la file est vide. */
  async dequeue(workflowId: string): Promise<WorkflowRun | null> {
    const { rows } = await pool.query<RunRow>(
      `UPDATE workflow_runs SET status = 'pending', heartbeat_at = now()
        WHERE id = (SELECT id FROM workflow_runs WHERE workflow_id = $1 AND status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [workflowId],
    );
    return rows[0] ? toRun(rows[0]) : null;
  },

  /** Workflows qui ont des exécutions en attente dans leur file. */
  async listWithQueue(): Promise<string[]> {
    const { rows } = await pool.query<{ workflow_id: string }>("SELECT DISTINCT workflow_id FROM workflow_runs WHERE status = 'queued'");
    return rows.map((r) => r.workflow_id);
  },

  async listStaleRuns(before: Date): Promise<WorkflowRun[]> {
    const { rows } = await pool.query<RunRow>("SELECT * FROM workflow_runs WHERE status IN ('pending', 'running') AND heartbeat_at < $1", [before]);
    return rows.map(toRun);
  },

  // ---- Nœuds d'une exécution ------------------------------------------------------------------

  /** Crée ou met à jour la ligne d'un nœud d'une exécution (les champs absents restent tels quels). */
  async upsertNode(runId: string, nodeKey: string, nodeType: WorkflowNodeType, patch: NodePatch): Promise<WorkflowRunNode> {
    const json = (v: unknown) => (v === undefined || v === null ? null : toJson(v));
    const { rows } = await pool.query<NodeRow>(
      `INSERT INTO workflow_run_nodes (run_id, node_key, node_type, status, input, output, error, started_at, finished_at)
       VALUES ($1, $2, $3, COALESCE($4, 'pending'), $5::jsonb, $6::jsonb, $7, $8, $9)
       ON CONFLICT (run_id, node_key) DO UPDATE SET
         status = COALESCE(EXCLUDED.status, workflow_run_nodes.status),
         input = COALESCE(EXCLUDED.input, workflow_run_nodes.input),
         output = COALESCE(EXCLUDED.output, workflow_run_nodes.output),
         error = COALESCE(EXCLUDED.error, workflow_run_nodes.error),
         started_at = COALESCE(EXCLUDED.started_at, workflow_run_nodes.started_at),
         finished_at = COALESCE(EXCLUDED.finished_at, workflow_run_nodes.finished_at)
       RETURNING *`,
      [runId, nodeKey, nodeType, patch.status ?? null, json(patch.input), json(patch.output), patch.error ?? null, patch.startedAt ?? null, patch.finishedAt ?? null],
    );
    return toNode(rows[0]);
  },

  async listNodes(runId: string): Promise<WorkflowRunNode[]> {
    const { rows } = await pool.query<NodeRow>('SELECT * FROM workflow_run_nodes WHERE run_id = $1 ORDER BY started_at NULLS LAST, id', [runId]);
    return rows.map(toNode);
  },

  // ---- Journal --------------------------------------------------------------------------------

  async addLog(runId: string, level: LogLevel, message: string, nodeKey: string | null, data: unknown | null): Promise<WorkflowRunLog> {
    const { rows } = await pool.query<LogRow>(`INSERT INTO workflow_run_logs (run_id, node_key, level, message, data) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`, [runId, nodeKey, level, message.slice(0, 4000), data === null || data === undefined ? null : toJson(data)]);
    return toLog(rows[0]);
  },

  async listLogs(runId: string, opts: { after?: string | null; limit?: number } = {}): Promise<WorkflowRunLog[]> {
    const params: unknown[] = [runId];
    let where = 'run_id = $1';
    if (opts.after) where += ` AND id > $${params.push(opts.after)}`;
    params.push(Math.min(opts.limit ?? 500, 2000));
    const { rows } = await pool.query<LogRow>(`SELECT * FROM workflow_run_logs WHERE ${where} ORDER BY id LIMIT $${params.length}`, params);
    return rows.map(toLog);
  },
};
