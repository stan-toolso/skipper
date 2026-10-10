import { pool } from '../db/pool.js';

export interface PushSubscriptionRow {
  id: string;
  userId: string;
  endpoint: string;
  /** JSON { p256dh, auth } chiffré. */
  keys: string;
  isAdmin: boolean;
}

interface Row {
  id: string;
  user_id: string;
  endpoint: string;
  keys: string;
  is_admin: boolean;
}
const toRow = (r: Row): PushSubscriptionRow => ({ id: r.id, userId: r.user_id, endpoint: r.endpoint, keys: r.keys, isAdmin: Boolean(r.is_admin) });

export const pushRepository = {
  /** Enregistre ou met à jour l'abonnement d'un appareil ; un appareil repris par une autre personne la suit. */
  async upsert(userId: string, endpoint: string, keys: string, userAgent: string | null): Promise<void> {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys, user_agent) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys, user_agent = EXCLUDED.user_agent, last_seen_at = now(), last_error = NULL`,
      [userId, endpoint, keys, userAgent],
    );
  },

  async delete(userId: string, endpoint: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
    return (rowCount ?? 0) > 0;
  },

  async deleteById(id: string): Promise<void> {
    await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [id]);
  },

  async recordError(id: string, error: string): Promise<void> {
    await pool.query('UPDATE push_subscriptions SET last_error = $2 WHERE id = $1', [id, error.slice(0, 500)]);
  },

  async listForUser(userId: string): Promise<PushSubscriptionRow[]> {
    const { rows } = await pool.query<Row>('SELECT s.*, u.is_admin FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1', [userId]);
    return rows.map(toRow);
  },

  /** Abonnements des personnes qui verraient la notification dans leur cloche. */
  async recipients(scope: { userId: string | null; adminsOnly: boolean; projectId: string | null }): Promise<PushSubscriptionRow[]> {
    const { rows } = await pool.query<Row>(
      `SELECT s.*, u.is_admin FROM push_subscriptions s JOIN users u ON u.id = s.user_id
       WHERE ($1::uuid IS NULL OR s.user_id = $1)
         AND (NOT $2::boolean OR u.is_admin)
         AND ($3::uuid IS NULL OR $1::uuid IS NOT NULL OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = $3 AND m.user_id = s.user_id))`,
      [scope.userId, scope.adminsOnly, scope.projectId],
    );
    return rows.map(toRow);
  },
};
