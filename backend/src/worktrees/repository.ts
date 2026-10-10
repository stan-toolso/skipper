import { pool } from '../db/pool.js';
import type { Worktree } from './types.js';

interface Row {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  label: string | null;
  archived_at: Date | null;
  created_at: Date;
}
const toWorktree = (r: Row): Worktree => ({ id: r.id, projectId: r.project_id, name: r.name, branch: r.branch, label: r.label ?? null, archivedAt: r.archived_at ?? null, createdAt: r.created_at });

export type ArchivedFilter = 'exclude' | 'only' | 'all';

export const worktreeRepository = {
  async create(projectId: string, name: string, branch: string, label: string | null = null): Promise<Worktree> {
    const { rows } = await pool.query<Row>('INSERT INTO worktrees (project_id, name, branch, label) VALUES ($1, $2, $3, $4) RETURNING *', [projectId, name, branch, label]);
    return toWorktree(rows[0]);
  },
  async findById(id: string): Promise<Worktree | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM worktrees WHERE id = $1', [id]);
    return rows[0] ? toWorktree(rows[0]) : null;
  },
  /** Worktree actif d'un projet sur une branche. */
  async findByBranch(projectId: string, branch: string): Promise<Worktree | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM worktrees WHERE project_id = $1 AND branch = $2 AND archived_at IS NULL LIMIT 1', [projectId, branch]);
    return rows[0] ? toWorktree(rows[0]) : null;
  },
  async listByProject(projectId: string, opts: { includeArchived?: boolean; archived?: ArchivedFilter } = {}): Promise<Worktree[]> {
    const archived: ArchivedFilter = opts.archived ?? (opts.includeArchived ? 'all' : 'exclude');
    const filter = archived === 'exclude' ? 'AND archived_at IS NULL' : archived === 'only' ? 'AND archived_at IS NOT NULL' : '';
    const order = archived === 'only' ? 'archived_at DESC' : 'created_at ASC';
    const { rows } = await pool.query<Row>(`SELECT * FROM worktrees WHERE project_id = $1 ${filter} ORDER BY ${order}`, [projectId]);
    return rows.map(toWorktree);
  },
  async update(id: string, patch: { name?: string; label?: string | null }): Promise<Worktree | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (patch.name !== undefined) sets.push(`name = $${params.push(patch.name)}`);
    if (patch.label !== undefined) sets.push(`label = $${params.push(patch.label)}`);
    if (!sets.length) return this.findById(id);
    const { rows } = await pool.query<Row>(`UPDATE worktrees SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toWorktree(rows[0]) : null;
  },
  async setArchived(id: string, at: Date | null): Promise<Worktree | null> {
    const { rows } = await pool.query<Row>('UPDATE worktrees SET archived_at = $2 WHERE id = $1 RETURNING *', [id, at]);
    return rows[0] ? toWorktree(rows[0]) : null;
  },
  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM worktrees WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },
  async countRunningSessions(worktreeId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE worktree_id = $1 AND status IN ('running', 'queued')`, [worktreeId]);
    return Number(rows[0].n);
  },
  /** Ce qui occupe le worktree : sessions actives (en cours, en file, en attente de démarrage) et terminaux ouverts. */
  async countBusy(worktreeId: string): Promise<{ sessions: number; terminals: number }> {
    const { rows } = await pool.query<{ s: string; t: string }>(
      `SELECT (SELECT count(*) FROM sessions WHERE worktree_id = $1 AND status IN ('pending', 'queued', 'running'))::text AS s,
              (SELECT count(*) FROM terminals WHERE worktree_id = $1 AND status = 'running')::text AS t`,
      [worktreeId],
    );
    return { sessions: Number(rows[0].s), terminals: Number(rows[0].t) };
  },
};
