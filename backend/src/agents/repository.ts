import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import { type Agent, type AgentAction, type AgentAvatar, type AgentKind, type AgentManager, type AgentManagerRole, type AgentStats, type AgentTriggers, normalizeAvatar, normalizeTriggers } from './types.js';

interface Row {
  user_id: string;
  project_id: string;
  kind: AgentKind;
  avatar: Partial<AgentAvatar> | null;
  description: string;
  instructions: string;
  task_folder: boolean;
  defaults: Record<string, unknown> | null;
  inherit_context: boolean;
  claude_delegate_id: string | null;
  github_delegate_id: string | null;
  github_delegate_read_only: boolean;
  github_delegate_pull_requests: boolean;
  github_delegate_merge: boolean;
  gitlab_delegate_id: string | null;
  gitlab_delegate_read_only: boolean;
  gitlab_delegate_pull_requests: boolean;
  gitlab_delegate_merge: boolean;
  allowed_models: string[] | null;
  triggers: Partial<AgentTriggers> | null;
  actions: AgentAction[] | null;
  enabled: boolean;
  archived_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  name: string;
  email: string;
}

interface ManagerRow {
  agent_user_id: string;
  user_id: string;
  role: AgentManagerRole;
  created_at: Date;
}

const normalizeAction = (a: Partial<AgentAction>): AgentAction => ({
  key: String(a.key ?? ''),
  label: String(a.label ?? ''),
  instruction: String(a.instruction ?? ''),
  cron: a.cron?.trim() || null,
  timezone: a.timezone?.trim() || null,
  scheduleId: a.scheduleId ?? null,
  ...(a.scheduleSessionId ? { scheduleSessionId: a.scheduleSessionId } : {}),
});

const toAgent = (r: Row): Agent => ({
  id: r.user_id,
  userId: r.user_id,
  name: r.name,
  email: r.email,
  projectId: r.project_id,
  kind: r.kind,
  avatar: normalizeAvatar(r.avatar),
  description: r.description ?? '',
  instructions: r.instructions ?? '',
  taskFolder: Boolean(r.task_folder),
  defaults: r.defaults ?? {},
  allowedModels: r.allowed_models ?? [],
  inheritContext: r.inherit_context ?? true,
  claudeDelegateId: r.claude_delegate_id ?? null,
  githubDelegateId: r.github_delegate_id ?? null,
  githubDelegateReadOnly: r.github_delegate_read_only ?? true,
  githubDelegatePullRequests: r.github_delegate_pull_requests ?? false,
  githubDelegateMerge: r.github_delegate_merge ?? false,
  gitlabDelegateId: r.gitlab_delegate_id ?? null,
  gitlabDelegateReadOnly: r.gitlab_delegate_read_only ?? true,
  gitlabDelegatePullRequests: r.gitlab_delegate_pull_requests ?? false,
  gitlabDelegateMerge: r.gitlab_delegate_merge ?? false,
  triggers: normalizeTriggers(r.triggers),
  actions: (r.actions ?? []).map(normalizeAction),
  enabled: Boolean(r.enabled),
  archivedAt: r.archived_at,
  createdById: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toManager = (r: ManagerRow): AgentManager => ({ agentId: r.agent_user_id, userId: r.user_id, role: r.role, createdAt: r.created_at });

const SELECT = `SELECT p.*, u.name, u.email FROM agent_profiles p JOIN users u ON u.id = p.user_id`;

export interface AgentProfilePatch {
  kind?: AgentKind;
  avatar?: AgentAvatar;
  description?: string;
  instructions?: string;
  taskFolder?: boolean;
  defaults?: Record<string, unknown>;
  allowedModels?: string[];
  inheritContext?: boolean;
  claudeDelegateId?: string | null;
  githubDelegateId?: string | null;
  githubDelegateReadOnly?: boolean;
  githubDelegatePullRequests?: boolean;
  githubDelegateMerge?: boolean;
  gitlabDelegateId?: string | null;
  gitlabDelegateReadOnly?: boolean;
  gitlabDelegatePullRequests?: boolean;
  gitlabDelegateMerge?: boolean;
  triggers?: AgentTriggers;
  actions?: AgentAction[];
  enabled?: boolean;
  archivedAt?: Date | null;
}

const patchColumns: Record<keyof AgentProfilePatch, string> = {
  kind: 'kind',
  avatar: 'avatar',
  description: 'description',
  instructions: 'instructions',
  taskFolder: 'task_folder',
  defaults: 'defaults',
  allowedModels: 'allowed_models',
  inheritContext: 'inherit_context',
  claudeDelegateId: 'claude_delegate_id',
  githubDelegateId: 'github_delegate_id',
  githubDelegateReadOnly: 'github_delegate_read_only',
  githubDelegatePullRequests: 'github_delegate_pull_requests',
  githubDelegateMerge: 'github_delegate_merge',
  gitlabDelegateId: 'gitlab_delegate_id',
  gitlabDelegateReadOnly: 'gitlab_delegate_read_only',
  gitlabDelegatePullRequests: 'gitlab_delegate_pull_requests',
  gitlabDelegateMerge: 'gitlab_delegate_merge',
  triggers: 'triggers',
  actions: 'actions',
  enabled: 'enabled',
  archivedAt: 'archived_at',
};
const jsonColumns = new Set(['avatar', 'defaults', 'triggers', 'actions']);

export const agentRepository = {
  async create(input: { userId: string; projectId: string; kind: AgentKind; avatar: AgentAvatar; description: string; instructions: string; taskFolder: boolean; defaults: Record<string, unknown>; allowedModels: string[]; inheritContext: boolean; triggers: AgentTriggers; actions: AgentAction[]; createdById: string | null }): Promise<Agent> {
    await pool.query(
      `INSERT INTO agent_profiles (user_id, project_id, kind, avatar, description, instructions, task_folder, defaults, inherit_context, triggers, actions, created_by, allowed_models)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [input.userId, input.projectId, input.kind, toJson(input.avatar), input.description, input.instructions, input.taskFolder, toJson(input.defaults), input.inheritContext, toJson(input.triggers), toJson(input.actions), input.createdById, input.allowedModels],
    );
    return (await this.findById(input.userId))!;
  },

  async findById(userId: string): Promise<Agent | null> {
    const { rows } = await pool.query<Row>(`${SELECT} WHERE p.user_id = $1`, [userId]);
    return rows[0] ? toAgent(rows[0]) : null;
  },

  /** Agents de ces identifiants (chargement groupé), sans ordre garanti. */
  async findByIds(ids: string[]): Promise<Agent[]> {
    if (!ids.length) return [];
    const { rows } = await pool.query<Row>(`${SELECT} WHERE p.user_id = ANY($1::uuid[])`, [ids]);
    return rows.map(toAgent);
  },

  async listByProject(projectId: string, { includeArchived = false }: { includeArchived?: boolean } = {}): Promise<Agent[]> {
    const { rows } = await pool.query<Row>(`${SELECT} WHERE p.project_id = $1${includeArchived ? '' : ' AND p.archived_at IS NULL'} ORDER BY u.name ASC`, [projectId]);
    return rows.map(toAgent);
  },

  /** Agents actifs (non archivés, activés) de ces projets : ceux qui réagissent aux déclencheurs et aux mentions. */
  async listActive(projectIds: string[]): Promise<Agent[]> {
    if (!projectIds.length) return [];
    const { rows } = await pool.query<Row>(`${SELECT} WHERE p.project_id = ANY($1::uuid[]) AND p.archived_at IS NULL AND p.enabled ORDER BY u.name ASC`, [projectIds]);
    return rows.map(toAgent);
  },

  async update(userId: string, patch: AgentProfilePatch): Promise<Agent | null> {
    const sets: string[] = [];
    const params: unknown[] = [userId];
    for (const [key, value] of Object.entries(patch) as [keyof AgentProfilePatch, unknown][]) {
      if (value === undefined) continue;
      params.push(jsonColumns.has(key) ? toJson(value) : value);
      sets.push(`${patchColumns[key]} = $${params.length}`);
    }
    if (!sets.length) return this.findById(userId);
    await pool.query(`UPDATE agent_profiles SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`, params);
    return this.findById(userId);
  },

  // ---- Gestionnaires -----------------------------------------------------------------------------

  async listManagers(agentId: string): Promise<AgentManager[]> {
    const { rows } = await pool.query<ManagerRow>(`SELECT * FROM agent_managers WHERE agent_user_id = $1 ORDER BY (role = 'owner') DESC, created_at ASC`, [agentId]);
    return rows.map(toManager);
  },

  /** Remplace la liste des gestionnaires. */
  async setManagers(agentId: string, managers: { userId: string; role: AgentManagerRole }[]): Promise<AgentManager[]> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM agent_managers WHERE agent_user_id = $1', [agentId]);
      for (const m of managers) await client.query('INSERT INTO agent_managers (agent_user_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (agent_user_id, user_id) DO UPDATE SET role = EXCLUDED.role', [agentId, m.userId, m.role]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return this.listManagers(agentId);
  },

  async isManager(agentId: string, userId: string): Promise<boolean> {
    const { rows } = await pool.query('SELECT 1 FROM agent_managers WHERE agent_user_id = $1 AND user_id = $2', [agentId, userId]);
    return rows.length > 0;
  },

  // ---- Activité ---------------------------------------------------------------------------------

  async stats(agentId: string): Promise<AgentStats> {
    const [sessions, tasks, cost] = await Promise.all([
      pool.query<{ active: string; total: string; last: Date | null }>(
        `SELECT count(*) FILTER (WHERE status IN ('running', 'queued'))::text AS active, count(*)::text AS total, max(updated_at) AS last FROM sessions WHERE owner_id = $1`,
        [agentId],
      ),
      pool.query<{ n: string }>(`SELECT count(DISTINCT ts.task_id)::text AS n FROM task_sessions ts JOIN sessions s ON s.id = ts.session_id WHERE s.owner_id = $1`, [agentId]),
      pool.query<{ month: string | null; total: string | null }>(
        `SELECT coalesce(sum(l.cost_usd) FILTER (WHERE l.recorded_at >= date_trunc('month', now())), 0)::text AS month, coalesce(sum(l.cost_usd), 0)::text AS total
         FROM usage_ledger l JOIN sessions s ON s.id = l.session_id WHERE s.owner_id = $1 AND l.billable`,
        [agentId],
      ),
    ]);
    return {
      activeSessions: Number(sessions.rows[0]?.active ?? 0),
      sessions: Number(sessions.rows[0]?.total ?? 0),
      tasks: Number(tasks.rows[0]?.n ?? 0),
      monthCostUsd: Number(cost.rows[0]?.month ?? 0),
      totalCostUsd: Number(cost.rows[0]?.total ?? 0),
      lastActivityAt: sessions.rows[0]?.last ?? null,
    };
  },

  /** Tâches où l'agent est intervenu (sessions reliées ou messages de ses sessions), les plus récentes d'abord. */
  async taskIdsTouched(agentId: string, limit = 50): Promise<string[]> {
    const { rows } = await pool.query<{ task_id: string }>(
      `SELECT task_id FROM (
         SELECT ts.task_id, max(ts.linked_at) AS at FROM task_sessions ts JOIN sessions s ON s.id = ts.session_id WHERE s.owner_id = $1 GROUP BY ts.task_id
         UNION ALL
         SELECT c.task_id, max(m.created_at) FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN sessions s ON s.id = m.author_session_id WHERE s.owner_id = $1 AND c.task_id IS NOT NULL GROUP BY c.task_id
       ) t GROUP BY task_id ORDER BY max(at) DESC LIMIT $2`,
      [agentId, limit],
    );
    return rows.map((r) => r.task_id);
  },

  /** Sessions de l'agent reliées à la tâche (en charge, créatrice, passée, mentionnée), non archivées, la plus récente d'abord. */
  async sessionIdsOnTask(agentId: string, taskId: string): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT s.id FROM task_sessions ts JOIN sessions s ON s.id = ts.session_id
       WHERE ts.task_id = $1 AND s.owner_id = $2 AND s.archived_at IS NULL AND s.kind = 'session' ORDER BY ts.linked_at DESC`,
      [taskId, agentId],
    );
    return rows.map((r) => r.id);
  },
};
