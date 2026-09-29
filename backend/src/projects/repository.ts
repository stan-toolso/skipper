import { pool } from '../db/pool.js';
import type { CreateProjectInput, Project, UpdateProjectInput } from './types.js';

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  system_prompt: string;
  git_url: string | null;
  git_branch: string | null;
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
    gitUrl: row.git_url,
    gitBranch: row.git_branch,
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
};

export const projectRepository = {
  async create(input: CreateProjectInput & { slug: string }): Promise<Project> {
    const { rows } = await pool.query<ProjectRow>(
      `INSERT INTO projects (name, slug, description, system_prompt, git_url, git_branch)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [input.name, input.slug, input.description ?? null, input.systemPrompt ?? '', input.gitUrl || null, input.gitBranch || null],
    );
    return toProject(rows[0]);
  },

  async findById(id: string): Promise<Project | null> {
    const { rows } = await pool.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]);
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

  /** Projets dont l'utilisateur est membre. */
  async listForUser(userId: string): Promise<Project[]> {
    const { rows } = await pool.query<ProjectRow>(
      'SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = $1 ORDER BY p.name ASC',
      [userId],
    );
    return rows.map(toProject);
  },

  async update(id: string, input: UpdateProjectInput): Promise<Project | null> {
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(updateColumns) as [keyof UpdateProjectInput, string][]) {
      const value = input[key];
      if (value === undefined) continue;
      // Les champs optionnels vides sont stockés en NULL ; le prompt système reste une chaîne.
      params.push(key === 'systemPrompt' ? value ?? '' : value || null);
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
