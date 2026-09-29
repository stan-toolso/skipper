import { pool } from '../db/pool.js';
import type { TerminalRecord, TerminalStatus } from './types.js';

interface Row {
  id: string;
  project_id: string;
  name: string;
  status: TerminalStatus;
  exit_code: number | null;
  created_at: Date;
  closed_at: Date | null;
}

const toRecord = (r: Row): TerminalRecord => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  status: r.status,
  exitCode: r.exit_code,
  createdAt: r.created_at,
  closedAt: r.closed_at,
});

export const terminalRepository = {
  async create(projectId: string, name: string): Promise<TerminalRecord> {
    const { rows } = await pool.query<Row>('INSERT INTO terminals (project_id, name) VALUES ($1, $2) RETURNING *', [projectId, name]);
    return toRecord(rows[0]);
  },
  async findById(id: string): Promise<TerminalRecord | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM terminals WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  },
  async listByProject(projectId: string): Promise<TerminalRecord[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM terminals WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
    return rows.map(toRecord);
  },
  async countByProject(projectId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM terminals WHERE project_id = $1', [projectId]);
    return Number(rows[0].n);
  },
  async close(id: string, exitCode: number | null): Promise<TerminalRecord | null> {
    const { rows } = await pool.query<Row>(
      `UPDATE terminals SET status = 'closed', exit_code = $2, closed_at = now() WHERE id = $1 AND status = 'running' RETURNING *`,
      [id, exitCode],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  },
  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM terminals WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },
  async closeAllRunning(): Promise<number> {
    const { rowCount } = await pool.query(`UPDATE terminals SET status = 'closed', closed_at = now() WHERE status = 'running'`);
    return rowCount ?? 0;
  },
};
