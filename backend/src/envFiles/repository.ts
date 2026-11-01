import { pool } from '../db/pool.js';
import type { EnvFile } from './types.js';

interface Row {
  id: string;
  project_id: string;
  path: string;
  content: string;
  apply_on_create: boolean;
  updated_by: string | null;
  updated_by_session: string | null;
  created_at: Date;
  updated_at: Date;
}

const toEnvFile = (r: Row): EnvFile => ({
  id: r.id,
  projectId: r.project_id,
  path: r.path,
  content: r.content,
  applyOnCreate: r.apply_on_create,
  updatedById: r.updated_by,
  updatedBySessionId: r.updated_by_session,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const envFileRepository = {
  async listByProject(projectId: string): Promise<EnvFile[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM project_env_files WHERE project_id = $1 ORDER BY path', [projectId]);
    return rows.map(toEnvFile);
  },
  async findById(id: string): Promise<EnvFile | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM project_env_files WHERE id = $1', [id]);
    return rows[0] ? toEnvFile(rows[0]) : null;
  },
  async findByPath(projectId: string, path: string): Promise<EnvFile | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM project_env_files WHERE project_id = $1 AND path = $2', [projectId, path]);
    return rows[0] ? toEnvFile(rows[0]) : null;
  },
  async create(projectId: string, input: { path: string; content: string; applyOnCreate: boolean; userId: string | null; sessionId: string | null }): Promise<EnvFile> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO project_env_files (project_id, path, content, apply_on_create, updated_by, updated_by_session) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [projectId, input.path, input.content, input.applyOnCreate, input.userId, input.sessionId],
    );
    return toEnvFile(rows[0]);
  },
  /**
   * Met à jour un fichier. `expectedUpdatedAt` : refus (null renvoyé) si le fichier a changé depuis cette date
   * (édition concurrente d'une personne et d'un agent).
   */
  async update(id: string, patch: { path?: string; content?: string; applyOnCreate?: boolean; userId: string | null; sessionId: string | null }, expectedUpdatedAt?: Date | null): Promise<EnvFile | null> {
    const params: unknown[] = [id, patch.userId, patch.sessionId];
    const sets = ['updated_by = $2', 'updated_by_session = $3', 'updated_at = now()'];
    if (patch.path !== undefined) sets.push(`path = $${params.push(patch.path)}`);
    if (patch.content !== undefined) sets.push(`content = $${params.push(patch.content)}`);
    if (patch.applyOnCreate !== undefined) sets.push(`apply_on_create = $${params.push(patch.applyOnCreate)}`);
    const guard = expectedUpdatedAt ? ` AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $${params.push(expectedUpdatedAt)}::timestamptz)` : '';
    const { rows } = await pool.query<Row>(`UPDATE project_env_files SET ${sets.join(', ')} WHERE id = $1${guard} RETURNING *`, params);
    return rows[0] ? toEnvFile(rows[0]) : null;
  },
  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM project_env_files WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },
};
