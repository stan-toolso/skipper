import { pool } from '../db/pool.js';
import { hostedGitUrl } from '../gitServer/paths.js';
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
  task_instructions: string | null;
  personal_owner_id: string | null;
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
    taskInstructions: row.task_instructions ?? '',
    personalOwnerId: row.personal_owner_id ?? null,
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
  taskInstructions: 'task_instructions',
};

export const projectRepository = {
  async create(input: CreateProjectInput & { slug: string }): Promise<Project> {
    const { rows } = await pool.query<ProjectRow>(
      `INSERT INTO projects (name, slug, description, system_prompt, git_url, git_branch, git_hosted, runner_config, default_permission_mode, task_instructions, personal_owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [input.name, input.slug, input.description ?? null, input.systemPrompt ?? '', input.gitHosted ? null : input.gitUrl || null, input.gitBranch || null, Boolean(input.gitHosted), JSON.stringify(input.runnerConfig ?? {}), input.defaultPermissionMode || 'default', input.taskInstructions ?? '', input.personalOwnerId ?? null],
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

  /** Projets dont l'utilisateur est membre, sans son espace personnel (sauf `includePersonal`). */
  async listForUser(userId: string, opts: { includePersonal?: boolean } = {}): Promise<Project[]> {
    const { rows } = await pool.query<ProjectRow>(
      `SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = $1${opts.includePersonal ? '' : ' AND p.personal_owner_id IS NULL'} ORDER BY p.name ASC`,
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
