import { pool } from '../db/pool.js';
import type { CreateRequestInput, HumanRequest, RequestStatus } from './types.js';

interface RequestRow {
  id: string;
  session_id: string;
  type: string;
  status: RequestStatus;
  title: string;
  message: string | null;
  payload: Record<string, unknown>;
  response: Record<string, unknown> | null;
  created_at: Date;
  answered_at: Date | null;
}

function toRequest(row: RequestRow): HumanRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    status: row.status,
    title: row.title,
    message: row.message,
    payload: row.payload ?? {},
    response: row.response,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}

export const requestRepository = {
  async create(sessionId: string, input: CreateRequestInput): Promise<HumanRequest> {
    const { rows } = await pool.query<RequestRow>(
      `INSERT INTO requests (session_id, type, title, message, payload)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [sessionId, input.type, input.title, input.message ?? null, JSON.stringify(input.payload ?? {})],
    );
    return toRequest(rows[0]);
  },

  async findById(id: string): Promise<HumanRequest | null> {
    const { rows } = await pool.query<RequestRow>('SELECT * FROM requests WHERE id = $1', [id]);
    return rows[0] ? toRequest(rows[0]) : null;
  },

  async list(filter: { sessionId?: string; status?: RequestStatus; limit?: number } = {}): Promise<HumanRequest[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.sessionId) {
      params.push(filter.sessionId);
      where.push(`session_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    params.push(Math.min(filter.limit ?? 100, 500));
    const { rows } = await pool.query<RequestRow>(
      `SELECT * FROM requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toRequest);
  },

  async countPending(sessionId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM requests WHERE session_id = $1 AND status = 'pending'`,
      [sessionId],
    );
    return Number(rows[0].n);
  },

  /** Passe une demande en attente à `status` ; renvoie null si elle n'était plus en attente. */
  async settle(id: string, status: Exclude<RequestStatus, 'pending'>, response: Record<string, unknown> | null): Promise<HumanRequest | null> {
    const { rows } = await pool.query<RequestRow>(
      `UPDATE requests SET status = $2, response = $3, answered_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, status, response === null ? null : JSON.stringify(response)],
    );
    return rows[0] ? toRequest(rows[0]) : null;
  },

  async settleAllPending(sessionId: string, status: 'cancelled' | 'expired'): Promise<HumanRequest[]> {
    const { rows } = await pool.query<RequestRow>(
      `UPDATE requests SET status = $2, answered_at = now()
       WHERE session_id = $1 AND status = 'pending' RETURNING *`,
      [sessionId, status],
    );
    return rows.map(toRequest);
  },

  /** Au redémarrage : toute demande encore en attente n'a plus de processus pour la consommer. */
  async expireAllPending(): Promise<number> {
    const { rowCount } = await pool.query(`UPDATE requests SET status = 'expired', answered_at = now() WHERE status = 'pending'`);
    return rowCount ?? 0;
  },
};
