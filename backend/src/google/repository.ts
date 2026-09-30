import { pool } from '../db/pool.js';
import type { GoogleAccess, GoogleAccount } from './types.js';

interface Row {
  id: string;
  project_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  google_sub: string;
  gmail_access: GoogleAccess;
  drive_access: GoogleAccess;
  scopes: string[];
  refresh_token: string;
  connected_by: string | null;
  last_check_at: Date | null;
  last_check_ok: boolean | null;
  last_check_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const toAccount = (r: Row): GoogleAccount => ({
  id: r.id,
  projectId: r.project_id,
  email: r.email,
  name: r.name,
  avatarUrl: r.avatar_url,
  googleSub: r.google_sub,
  gmailAccess: r.gmail_access,
  driveAccess: r.drive_access,
  scopes: Array.isArray(r.scopes) ? r.scopes : [],
  refreshToken: r.refresh_token,
  connectedById: r.connected_by,
  lastCheckAt: r.last_check_at,
  lastCheckOk: r.last_check_ok,
  lastCheckError: r.last_check_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface GoogleAccountRecordInput {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  googleSub: string;
  gmailAccess: GoogleAccess;
  driveAccess: GoogleAccess;
  scopes: string[];
  /** Déjà chiffré. */
  refreshToken: string;
  connectedById: string | null;
}

export const googleAccountRepository = {
  async listByProject(projectId: string): Promise<GoogleAccount[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM project_google_accounts WHERE project_id = $1 ORDER BY created_at, email', [projectId]);
    return rows.map(toAccount);
  },

  async findById(id: string): Promise<GoogleAccount | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM project_google_accounts WHERE id = $1', [id]);
    return rows[0] ? toAccount(rows[0]) : null;
  },

  async findByProjectAndSub(projectId: string, googleSub: string): Promise<GoogleAccount | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM project_google_accounts WHERE project_id = $1 AND google_sub = $2', [projectId, googleSub]);
    return rows[0] ? toAccount(rows[0]) : null;
  },

  /** Nombre de rattachements (tous projets) d'un même compte Google, pour ne pas révoquer un jeton encore partagé. */
  async countBySub(googleSub: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM project_google_accounts WHERE google_sub = $1', [googleSub]);
    return rows[0]?.n ?? 0;
  },

  /** Crée le compte, ou le met à jour si ce compte Google est déjà relié au projet (reconnexion, changement d'accès). */
  async upsert(projectId: string, input: GoogleAccountRecordInput): Promise<GoogleAccount> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO project_google_accounts (project_id, email, name, avatar_url, google_sub, gmail_access, drive_access, scopes, refresh_token, connected_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       ON CONFLICT (project_id, google_sub) DO UPDATE SET
         email = EXCLUDED.email, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url,
         gmail_access = EXCLUDED.gmail_access, drive_access = EXCLUDED.drive_access, scopes = EXCLUDED.scopes,
         refresh_token = EXCLUDED.refresh_token, connected_by = EXCLUDED.connected_by,
         last_check_at = NULL, last_check_ok = NULL, last_check_error = NULL, updated_at = now()
       RETURNING *`,
      [projectId, input.email, input.name, input.avatarUrl, input.googleSub, input.gmailAccess, input.driveAccess, JSON.stringify(input.scopes), input.refreshToken, input.connectedById],
    );
    return toAccount(rows[0]);
  },

  async recordCheck(id: string, ok: boolean, error: string | null): Promise<void> {
    await pool.query('UPDATE project_google_accounts SET last_check_at = now(), last_check_ok = $2, last_check_error = $3 WHERE id = $1', [id, ok, error]);
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM project_google_accounts WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },
};
