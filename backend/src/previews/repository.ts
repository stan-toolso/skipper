import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';

export interface PreviewRow {
  worksessionId: string;
  projectId: string;
  hostLabel: string;
  port: number;
  startedBy: string | null;
  startedAt: Date | null;
}

interface Row {
  worksession_id: string;
  project_id: string;
  host_label: string;
  port: number;
  started_by: string | null;
  started_at: Date | null;
}
const toPreview = (r: Row): PreviewRow => ({ worksessionId: r.worksession_id, projectId: r.project_id, hostLabel: r.host_label, port: r.port, startedBy: r.started_by, startedAt: r.started_at });

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export const previewRepository = {
  async find(worksessionId: string): Promise<PreviewRow | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM previews WHERE worksession_id = $1', [worksessionId]);
    return rows[0] ? toPreview(rows[0]) : null;
  },
  async findByLabel(label: string): Promise<PreviewRow | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM previews WHERE host_label = $1', [label]);
    return rows[0] ? toPreview(rows[0]) : null;
  },
  async portsOfProject(projectId: string): Promise<number[]> {
    const { rows } = await pool.query<{ port: number }>('SELECT port FROM previews WHERE project_id = $1', [projectId]);
    return rows.map((r) => r.port);
  },
  /** Crée la ligne de l'aperçu ; null si le nom ou le port vient d'être pris (l'appelant réessaie). */
  async create(worksessionId: string, projectId: string, hostLabel: string, port: number): Promise<PreviewRow | null> {
    const { rows } = await pool.query<Row>(
      'INSERT INTO previews (worksession_id, project_id, host_label, port) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *',
      [worksessionId, projectId, hostLabel, port],
    );
    return rows[0] ? toPreview(rows[0]) : null;
  },
  async markStarted(worksessionId: string, userId: string | null): Promise<void> {
    await pool.query('UPDATE previews SET started_by = $2, started_at = now() WHERE worksession_id = $1', [worksessionId, userId]);
  },

  async createToken(token: string, kind: 'grant' | 'access', worksessionId: string, userId: string, ttlMs: number): Promise<Date> {
    const expires = new Date(Date.now() + ttlMs);
    await pool.query('INSERT INTO preview_access (token_hash, kind, worksession_id, user_id, expires_at) VALUES ($1, $2, $3, $4, $5)', [tokenHash(token), kind, worksessionId, userId, expires]);
    return expires;
  },
  /** Consomme un lien d'accès (usage unique, non expiré) ; renvoie la work session et la personne, ou null. */
  async useGrant(token: string): Promise<{ worksessionId: string; userId: string } | null> {
    const { rows } = await pool.query<{ worksession_id: string; user_id: string }>(
      `UPDATE preview_access SET used_at = now() WHERE token_hash = $1 AND kind = 'grant' AND used_at IS NULL AND expires_at > now()
       RETURNING worksession_id, user_id`,
      [tokenHash(token)],
    );
    return rows[0] ? { worksessionId: rows[0].worksession_id, userId: rows[0].user_id } : null;
  },
  async findAccess(token: string): Promise<{ worksessionId: string; userId: string; expiresAt: Date } | null> {
    const { rows } = await pool.query<{ worksession_id: string; user_id: string; expires_at: Date }>(
      `SELECT worksession_id, user_id, expires_at FROM preview_access WHERE token_hash = $1 AND kind = 'access' AND expires_at > now()`,
      [tokenHash(token)],
    );
    return rows[0] ? { worksessionId: rows[0].worksession_id, userId: rows[0].user_id, expiresAt: rows[0].expires_at } : null;
  },
  async purgeExpired(): Promise<number> {
    const { rowCount } = await pool.query(`DELETE FROM preview_access WHERE expires_at < now() - interval '1 day'`);
    return rowCount ?? 0;
  },
};
