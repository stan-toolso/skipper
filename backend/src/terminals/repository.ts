import { pool } from '../db/pool.js';
import type { TerminalRecord, TerminalStatus } from './types.js';

interface Row {
  id: string;
  project_id: string;
  worksession_id: string | null;
  created_by: string | null;
  name: string;
  status: TerminalStatus;
  exit_code: number | null;
  created_at: Date;
  closed_at: Date | null;
  instance_id: string | null;
}

const toRecord = (r: Row): TerminalRecord => ({
  id: r.id,
  projectId: r.project_id,
  worksessionId: r.worksession_id,
  createdById: r.created_by ?? null,
  name: r.name,
  status: r.status,
  exitCode: r.exit_code,
  createdAt: r.created_at,
  closedAt: r.closed_at,
  instanceId: r.instance_id ?? null,
});

/** Lignes d'historique conservées par projet et par utilisateur. */
export const HISTORY_LIMIT = 5000;

export const terminalRepository = {
  async create(projectId: string, name: string, worksessionId: string | null = null, createdById: string | null = null, instanceId: string | null = null): Promise<TerminalRecord> {
    const { rows } = await pool.query<Row>('INSERT INTO terminals (project_id, name, worksession_id, created_by, instance_id) VALUES ($1, $2, $3, $4, $5) RETURNING *', [projectId, name, worksessionId, createdById, instanceId]);
    return toRecord(rows[0]);
  },
  async findById(id: string): Promise<TerminalRecord | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM terminals WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  },
  /** Terminaux d'un projet, ceux d'une personne seulement si `userId` est donné. */
  async listByProject(projectId: string, userId?: string | null): Promise<TerminalRecord[]> {
    const params: unknown[] = [projectId];
    const owner = userId ? `AND created_by = $${params.push(userId)}` : '';
    const { rows } = await pool.query<Row>(`SELECT * FROM terminals WHERE project_id = $1 ${owner} ORDER BY created_at DESC`, params);
    return rows.map(toRecord);
  },
  async countByProject(projectId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM terminals WHERE project_id = $1', [projectId]);
    return Number(rows[0].n);
  },
  async close(id: string, exitCode: number | null): Promise<TerminalRecord | null> {
    const { rows } = await pool.query<Row>(`UPDATE terminals SET status = 'closed', exit_code = $2, closed_at = now() WHERE id = $1 AND status = 'running' RETURNING *`, [id, exitCode]);
    return rows[0] ? toRecord(rows[0]) : null;
  },
  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM terminals WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },
  /** Terminaux ouverts dont le shell ne tourne plus : ceux qu'aucune instance vivante du backend (`liveInstanceIds`) ne tient. */
  async closeAllRunning(liveInstanceIds: string[] = []): Promise<number> {
    const { rowCount } = await pool.query(
      `UPDATE terminals SET status = 'closed', closed_at = now() WHERE status = 'running' AND (instance_id IS NULL OR NOT instance_id = ANY($1::uuid[]))`,
      [liveInstanceIds],
    );
    return rowCount ?? 0;
  },

  // ---- Historique des commandes ----------------------------------------------------------------

  async history(projectId: string, userId: string): Promise<string[]> {
    const { rows } = await pool.query<{ lines: string[] }>('SELECT lines FROM terminal_histories WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    return rows[0]?.lines ?? [];
  },

  /** Ajoute des lignes à l'historique en ne gardant que les `limit` dernières. */
  async appendHistory(projectId: string, userId: string, lines: string[], limit = HISTORY_LIMIT): Promise<void> {
    if (!lines.length) return;
    await pool.query(
      `INSERT INTO terminal_histories (project_id, user_id, lines, updated_at) VALUES ($1, $2, $3::text[], now())
       ON CONFLICT (project_id, user_id) DO UPDATE SET
         lines = (SELECT arr[greatest(1, cardinality(arr) - $4 + 1):] FROM (SELECT terminal_histories.lines || EXCLUDED.lines AS arr) x),
         updated_at = now()`,
      [projectId, userId, lines.slice(-limit), limit],
    );
  },
};
