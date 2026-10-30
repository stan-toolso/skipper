import { pool } from '../db/pool.js';
import type { Worksession } from './types.js';

interface Row {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  label: string | null;
  task_id: string | null;
  archived_at: Date | null;
  created_at: Date;
}
const toWorksession = (r: Row): Worksession => ({ id: r.id, projectId: r.project_id, name: r.name, branch: r.branch, label: r.label ?? null, taskId: r.task_id ?? null, archivedAt: r.archived_at ?? null, createdAt: r.created_at });

export type ArchivedFilter = 'exclude' | 'only' | 'all';

export const worksessionRepository = {
  async create(projectId: string, name: string, branch: string, label: string | null = null, taskId: string | null = null): Promise<Worksession> {
    const { rows } = await pool.query<Row>('INSERT INTO worksessions (project_id, name, branch, label, task_id) VALUES ($1, $2, $3, $4, $5) RETURNING *', [projectId, name, branch, label, taskId]);
    return toWorksession(rows[0]);
  },
  /** Work sessions consacrées à une tâche : l'active d'abord, puis les archivées (la plus récente d'abord). */
  async findByTask(taskId: string): Promise<Worksession[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM worksessions WHERE task_id = $1 ORDER BY (archived_at IS NOT NULL), archived_at DESC, created_at DESC', [taskId]);
    return rows.map(toWorksession);
  },
  async findById(id: string): Promise<Worksession | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM worksessions WHERE id = $1', [id]);
    return rows[0] ? toWorksession(rows[0]) : null;
  },
  /** Work sessions de ces identifiants (chargement groupé par requête GraphQL), sans ordre garanti. */
  async findByIds(ids: string[]): Promise<Worksession[]> {
    if (!ids.length) return [];
    const { rows } = await pool.query<Row>('SELECT * FROM worksessions WHERE id = ANY($1::uuid[])', [ids]);
    return rows.map(toWorksession);
  },
  /** Worksession actif d'un projet sur une branche. */
  async findByBranch(projectId: string, branch: string): Promise<Worksession | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM worksessions WHERE project_id = $1 AND branch = $2 AND archived_at IS NULL LIMIT 1', [projectId, branch]);
    return rows[0] ? toWorksession(rows[0]) : null;
  },
  async listByProject(projectId: string, opts: { includeArchived?: boolean; archived?: ArchivedFilter } = {}): Promise<Worksession[]> {
    const archived: ArchivedFilter = opts.archived ?? (opts.includeArchived ? 'all' : 'exclude');
    const filter = archived === 'exclude' ? 'AND archived_at IS NULL' : archived === 'only' ? 'AND archived_at IS NOT NULL' : '';
    const order = archived === 'only' ? 'archived_at DESC' : 'created_at ASC';
    const { rows } = await pool.query<Row>(`SELECT * FROM worksessions WHERE project_id = $1 ${filter} ORDER BY ${order}`, [projectId]);
    return rows.map(toWorksession);
  },
  async update(id: string, patch: { name?: string; label?: string | null }): Promise<Worksession | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (patch.name !== undefined) sets.push(`name = $${params.push(patch.name)}`);
    if (patch.label !== undefined) sets.push(`label = $${params.push(patch.label)}`);
    if (!sets.length) return this.findById(id);
    const { rows } = await pool.query<Row>(`UPDATE worksessions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toWorksession(rows[0]) : null;
  },
  async setArchived(id: string, at: Date | null): Promise<Worksession | null> {
    const { rows } = await pool.query<Row>('UPDATE worksessions SET archived_at = $2 WHERE id = $1 RETURNING *', [id, at]);
    return rows[0] ? toWorksession(rows[0]) : null;
  },
  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM worksessions WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },
  async countRunningSessions(worksessionId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE worksession_id = $1 AND status IN ('running', 'queued')`, [worksessionId]);
    return Number(rows[0].n);
  },
  /** Ce qui occupe la work session : sessions actives (en cours, en file, en attente de démarrage) et terminaux ouverts. */
  async countBusy(worksessionId: string): Promise<{ sessions: number; terminals: number }> {
    const { rows } = await pool.query<{ s: string; t: string }>(
      `SELECT (SELECT count(*) FROM sessions WHERE worksession_id = $1 AND status IN ('pending', 'queued', 'running'))::text AS s,
              (SELECT count(*) FROM terminals WHERE worksession_id = $1 AND status = 'running')::text AS t`,
      [worksessionId],
    );
    return { sessions: Number(rows[0].s), terminals: Number(rows[0].t) };
  },
};
