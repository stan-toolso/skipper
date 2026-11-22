import { pool } from '../db/pool.js';
import { hostedGitUrl } from '../gitServer/paths.js';
import { toJson } from '../db/json.js';
import type { SessionCleanup } from '../sessions/types.js';
import type { TaskModels } from './models.js';
import { projectTaskStatuses } from '../tasks/statuses.js';
import type { CreateProjectInput, Project, ProjectPermissionMode, UpdateProjectInput } from './types.js';

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  system_prompt: string;
  git_url: string | null;
  git_branch: string | null;
  git_hosted: boolean;
  runner_config: Record<string, unknown>;
  default_permission_mode: ProjectPermissionMode;
  default_context_cleanup: SessionCleanup | null;
  default_model: string | null;
  task_models: TaskModels | null;
  task_instructions: string | null;
  task_statuses: unknown;
  personal_owner_id: string | null;
  monthly_budget_usd: string | null;
  created_at: Date;
  updated_at: Date;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    systemPrompt: row.system_prompt,
    // Dépôt hébergé : l'URL de clone suit l'adresse de l'API (jamais stockée, pour survivre à un changement de domaine).
    gitUrl: row.git_hosted ? hostedGitUrl(row.slug) : row.git_url,
    gitBranch: row.git_branch,
    gitHosted: Boolean(row.git_hosted),
    runnerConfig: row.runner_config ?? {},
    defaultPermissionMode: row.default_permission_mode ?? 'default',
    defaultContextCleanup: row.default_context_cleanup ?? null,
    defaultModel: row.default_model ?? null,
    taskModels: row.task_models ?? null,
    taskInstructions: row.task_instructions ?? '',
    taskStatuses: projectTaskStatuses(row.task_statuses),
    taskStatusesCustomized: Array.isArray(row.task_statuses) && row.task_statuses.length > 0,
    personalOwnerId: row.personal_owner_id ?? null,
    monthlyBudgetUsd: row.monthly_budget_usd == null ? null : Number(row.monthly_budget_usd),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const updateColumns: Record<keyof UpdateProjectInput, string> = {
  name: 'name',
  description: 'description',
  systemPrompt: 'system_prompt',
  gitUrl: 'git_url',
  gitBranch: 'git_branch',
  gitHosted: 'git_hosted',
  runnerConfig: 'runner_config',
  defaultPermissionMode: 'default_permission_mode',
  defaultContextCleanup: 'default_context_cleanup',
  defaultModel: 'default_model',
  taskModels: 'task_models',
  taskInstructions: 'task_instructions',
  taskStatuses: 'task_statuses',
  monthlyBudgetUsd: 'monthly_budget_usd',
};

export const projectRepository = {
  async create(input: CreateProjectInput & { slug: string }): Promise<Project> {
    const { rows } = await pool.query<ProjectRow>(
      `INSERT INTO projects (name, slug, description, system_prompt, git_url, git_branch, git_hosted, runner_config, default_permission_mode, task_instructions, personal_owner_id, default_context_cleanup, default_model, task_models)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb) RETURNING *`,
      [input.name, input.slug, input.description ?? null, input.systemPrompt ?? '', input.gitHosted ? null : input.gitUrl || null, input.gitBranch || null, Boolean(input.gitHosted), JSON.stringify(input.runnerConfig ?? {}), input.defaultPermissionMode || 'default', input.taskInstructions ?? '', input.personalOwnerId ?? null, input.defaultContextCleanup ? toJson(input.defaultContextCleanup) : null, input.defaultModel ?? null, input.taskModels ? toJson(input.taskModels) : null],
    );
    return toProject(rows[0]);
  },

  async findById(id: string): Promise<Project | null> {
    const { rows } = await pool.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]);
    return rows[0] ? toProject(rows[0]) : null;
  },

  /** Projets de ces identifiants (chargement groupé par requête GraphQL), sans ordre garanti. */
  async findByIds(ids: string[]): Promise<Project[]> {
    if (!ids.length) return [];
    const { rows } = await pool.query<ProjectRow>('SELECT * FROM projects WHERE id = ANY($1::uuid[])', [ids]);
    return rows.map(toProject);
  },

  async findBySlug(slug: string): Promise<Project | null> {
    const { rows } = await pool.query<ProjectRow>('SELECT * FROM projects WHERE slug = $1', [slug]);
    return rows[0] ? toProject(rows[0]) : null;
  },

  async slugExists(slug: string): Promise<boolean> {
    const { rowCount } = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
    return (rowCount ?? 0) > 0;
  },

  async list(): Promise<Project[]> {
    const { rows } = await pool.query<ProjectRow>('SELECT * FROM projects ORDER BY name ASC');
    return rows.map(toProject);
  },

  /**
   * Projets dont l'utilisateur est membre (au moins lecteur), sans son espace personnel (sauf `includePersonal`) ni
   * ceux où il n'est qu'invité (`guests: 'include'` les ajoute, `guests: 'only'` ne garde qu'eux).
   */
  async listForUser(userId: string, opts: { includePersonal?: boolean; guests?: 'exclude' | 'include' | 'only' } = {}): Promise<Project[]> {
    const guests = opts.guests ?? 'exclude';
    const roleFilter = guests === 'include' ? '' : guests === 'only' ? " AND m.role = 'guest'" : " AND m.role <> 'guest'";
    const { rows } = await pool.query<ProjectRow>(
      `SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = $1${opts.includePersonal ? '' : ' AND p.personal_owner_id IS NULL'}${roleFilter} ORDER BY p.name ASC`,
      [userId],
    );
    return rows.map(toProject);
  },

  /** Espace personnel d'une personne, s'il existe. */
  async findPersonal(userId: string): Promise<Project | null> {
    const { rows } = await pool.query<ProjectRow>('SELECT * FROM projects WHERE personal_owner_id = $1', [userId]);
    return rows[0] ? toProject(rows[0]) : null;
  },

  /** Personne à qui appartient le projet s'il est un espace personnel, null sinon (ou si le projet n'existe pas). */
  async personalOwnerOf(projectId: string): Promise<string | null> {
    const { rows } = await pool.query<{ personal_owner_id: string | null }>('SELECT personal_owner_id FROM projects WHERE id = $1', [projectId]);
    return rows[0]?.personal_owner_id ?? null;
  },

  async update(id: string, input: UpdateProjectInput): Promise<Project | null> {
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(updateColumns) as [keyof UpdateProjectInput, string][]) {
      const value = input[key];
      if (value === undefined) continue;
      if (key === 'runnerConfig') {
        params.push(JSON.stringify(value ?? {}));
        sets.push(`${column} = $${params.length}::jsonb`);
        continue;
      }
      if (key === 'defaultContextCleanup' || key === 'taskModels' || key === 'taskStatuses') {
        params.push(value && !(Array.isArray(value) && value.length === 0) ? toJson(value) : null);
        sets.push(`${column} = $${params.length}::jsonb`);
        continue;
      }
      if (key === 'monthlyBudgetUsd') {
        params.push(typeof value === 'number' && value > 0 ? value : null);
        sets.push(`${column} = $${params.length}`);
        // Nouveau budget : les paliers d'alerte (80 %, 100 %) repartent de zéro.
        sets.push('budget_alert_month = NULL', 'budget_alert_level = NULL');
        continue;
      }
      if (key === 'gitHosted') {
        params.push(Boolean(value));
        sets.push(`${column} = $${params.length}`);
        continue;
      }
      // Les champs optionnels vides sont stockés en NULL ; le prompt système reste une chaîne, le mode d'autorisation a une valeur par défaut.
      params.push(key === 'systemPrompt' || key === 'taskInstructions' ? value ?? '' : key === 'defaultPermissionMode' ? value || 'default' : value || null);
      sets.push(`${column} = $${params.length}`);
    }
    const { rows } = await pool.query<ProjectRow>(`UPDATE projects SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toProject(rows[0]) : null;
  },

  /** Oublie le statut des tâches du projet qui ne correspond plus à aucun statut de sa catégorie (null : statut par défaut). */
  async resetStaleTaskStates(id: string, statuses: { key: string; category: string }[]): Promise<number> {
    const { rowCount } = await pool.query(
      `UPDATE tasks t SET state = NULL WHERE t.project_id = $1 AND t.state IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS s(key text, category text) WHERE s.key = t.state AND s.category = t.status::text)`,
      [id, toJson(statuses.map((s) => ({ key: s.key, category: s.category })))],
    );
    return rowCount ?? 0;
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM projects WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  async countRunningSessions(projectId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sessions WHERE project_id = $1 AND status = 'running'`,
      [projectId],
    );
    return Number(rows[0].n);
  },
};
