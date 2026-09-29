import { pool } from '../db/pool.js';
import type { Worktree } from './types.js';

interface Row {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  created_at: Date;
}
const toWorktree = (r: Row): Worktree => ({ id: r.id, projectId: r.project_id, name: r.name, branch: r.branch, createdAt: r.created_at });

export const worktreeRepository = {
  async create(projectId: string, name: string, branch: string): Promise<Worktree> {
    const { rows } = await pool.query<Row>('INSERT INTO worktrees (project_id, name, branch) VALUES ($1, $2, $3) RETURNING *', [projectId, name, branch]);
    return toWorktree(rows[0]);
  },
  async findById(id: string): Promise<Worktree | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM worktrees WHERE id = $1', [id]);
    return rows[0] ? toWorktree(rows[0]) : null;
  },
  async listByProject(projectId: string): Promise<Worktree[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM worktrees WHERE project_id = $1 ORDER BY created_at ASC', [projectId]);
    return rows.map(toWorktree);
  },
  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM worktrees WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },
  async countRunningSessions(worktreeId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE worktree_id = $1 AND status = 'running'`, [worktreeId]);
    return Number(rows[0].n);
  },
};
