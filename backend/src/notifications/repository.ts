import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { Notification, NotifyInput } from './types.js';

interface Row {
  id: string;
  type: string;
  title: string;
  message: string | null;
  link: string | null;
  project_id: string | null;
  session_id: string | null;
  payload: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

const toNotification = (r: Row): Notification => ({
  id: String(r.id),
  type: r.type,
  title: r.title,
  message: r.message,
  link: r.link,
  projectId: r.project_id,
  sessionId: r.session_id,
  payload: r.payload ?? {},
  readAt: r.read_at,
  createdAt: r.created_at,
});

export const notificationRepository = {
  async create(input: NotifyInput): Promise<Notification> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO notifications (type, title, message, link, project_id, session_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [input.type, input.title, input.message ?? null, input.link ?? null, input.projectId ?? null, input.sessionId ?? null, toJson(input.payload ?? {})],
    );
    return toNotification(rows[0]);
  },
  async findById(id: string): Promise<Notification | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM notifications WHERE id = $1', [id]);
    return rows[0] ? toNotification(rows[0]) : null;
  },
  async list(opts: { unreadOnly?: boolean; limit?: number; projectIds?: string[] } = {}): Promise<Notification[]> {
    const where = [...(opts.unreadOnly ? ['read_at IS NULL'] : []), ...(opts.projectIds ? ['(project_id IS NULL OR project_id = ANY($2::uuid[]))'] : [])];
    const params: unknown[] = [Math.min(opts.limit ?? 50, 200)];
    if (opts.projectIds) params.push(opts.projectIds);
    const { rows } = await pool.query<Row>(`SELECT * FROM notifications ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $1`, params);
    return rows.map(toNotification);
  },
  async countUnread(projectIds?: string[]): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notifications WHERE read_at IS NULL ${projectIds ? 'AND (project_id IS NULL OR project_id = ANY($1::uuid[]))' : ''}`,
      projectIds ? [projectIds] : [],
    );
    return Number(rows[0].n);
  },
  async markRead(id: string): Promise<Notification | null> {
    const { rows } = await pool.query<Row>('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 RETURNING *', [id]);
    return rows[0] ? toNotification(rows[0]) : null;
  },
  async markAllRead(projectIds?: string[]): Promise<number> {
    const { rowCount } = await pool.query(
      `UPDATE notifications SET read_at = now() WHERE read_at IS NULL ${projectIds ? 'AND (project_id IS NULL OR project_id = ANY($1::uuid[]))' : ''}`,
      projectIds ? [projectIds] : [],
    );
    return rowCount ?? 0;
  },
};
