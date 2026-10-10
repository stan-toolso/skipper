import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { Notification, NotificationScope, NotifyInput } from './types.js';

interface Row {
  id: string;
  type: string;
  title: string;
  message: string | null;
  link: string | null;
  project_id: string | null;
  session_id: string | null;
  payload: Record<string, unknown>;
  admins_only: boolean;
  user_id: string | null;
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
  adminsOnly: Boolean(r.admins_only),
  userId: r.user_id ?? null,
  readAt: r.read_at,
  createdAt: r.created_at,
});

/**
 * Périmètre d'une personne : les notifications qui lui sont adressées, et parmi les autres (non adressées) celles
 * de ses projets (ou sans projet), réservées aux administrateurs seulement si elle l'est.
 */
function scopeWhere(scope: NotificationScope): { where: string[]; params: unknown[] } {
  const params: unknown[] = [];
  const general: string[] = ['user_id IS NULL'];
  if (scope.projectIds) general.push(`(project_id IS NULL OR project_id = ANY($${params.push(scope.projectIds)}::uuid[]))`);
  if (!scope.admin) general.push('NOT admins_only');
  const clauses = [`(${general.join(' AND ')})`];
  if (scope.userId) clauses.push(`user_id = $${params.push(scope.userId)}`);
  return { where: [`(${clauses.join(' OR ')})`], params };
}

export const notificationRepository = {
  async create(input: NotifyInput): Promise<Notification> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO notifications (type, title, message, link, project_id, session_id, payload, admins_only, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [input.type, input.title, input.message ?? null, input.link ?? null, input.projectId ?? null, input.sessionId ?? null, toJson(input.payload ?? {}), input.adminsOnly ?? false, input.userId ?? null],
    );
    return toNotification(rows[0]);
  },
  async findById(id: string): Promise<Notification | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM notifications WHERE id = $1', [id]);
    return rows[0] ? toNotification(rows[0]) : null;
  },
  async list(opts: { unreadOnly?: boolean; limit?: number } & NotificationScope = {}): Promise<Notification[]> {
    const { where, params } = scopeWhere(opts);
    if (opts.unreadOnly) where.push('read_at IS NULL');
    params.push(Math.min(opts.limit ?? 50, 200));
    const { rows } = await pool.query<Row>(`SELECT * FROM notifications ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(toNotification);
  },
  async countUnread(scope: NotificationScope = {}): Promise<number> {
    const { where, params } = scopeWhere(scope);
    where.push('read_at IS NULL');
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE ${where.join(' AND ')}`, params);
    return Number(rows[0].n);
  },
  async markRead(id: string): Promise<Notification | null> {
    const { rows } = await pool.query<Row>('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 RETURNING *', [id]);
    return rows[0] ? toNotification(rows[0]) : null;
  },
  /** Marque lues les notifications « demande » (type request.created) portant sur ces demandes. */
  async markReadForRequests(requestIds: string[]): Promise<number> {
    if (requestIds.length === 0) return 0;
    const { rowCount } = await pool.query(
      `UPDATE notifications SET read_at = now()
       WHERE read_at IS NULL AND type = 'request.created' AND payload->>'requestId' = ANY($1::text[])`,
      [requestIds],
    );
    return rowCount ?? 0;
  },
  /** Marque lues les notifications « demande » dont la demande n'est plus en attente (rattrapage au démarrage). */
  async markReadForSettledRequests(): Promise<number> {
    const { rowCount } = await pool.query(
      `UPDATE notifications n SET read_at = now()
       FROM requests r
       WHERE n.read_at IS NULL AND n.type = 'request.created' AND r.id::text = n.payload->>'requestId' AND r.status <> 'pending'`,
    );
    return rowCount ?? 0;
  },
  async markAllRead(scope: NotificationScope = {}): Promise<number> {
    const { where, params } = scopeWhere(scope);
    where.push('read_at IS NULL');
    const { rowCount } = await pool.query(`UPDATE notifications SET read_at = now() WHERE ${where.join(' AND ')}`, params);
    return rowCount ?? 0;
  },
};
