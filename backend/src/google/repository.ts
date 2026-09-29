import { pool } from '../db/pool.js';
import type { GoogleAccess, GoogleAccount } from './types.js';

interface Row {
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
  async findByProject(projectId: string): Promise<GoogleAccount | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM project_google_accounts WHERE project_id = $1', [projectId]);
    return rows[0] ? toAccount(rows[0]) : null;
  },

  /** Crée ou remplace le compte du projet (relier un autre compte, ou changer les accès). */
  async upsert(projectId: string, input: GoogleAccountRecordInput): Promise<GoogleAccount> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO project_google_accounts (project_id, email, name, avatar_url, google_sub, gmail_access, drive_access, scopes, refresh_token, connected_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       ON CONFLICT (project_id) DO UPDATE SET
         email = EXCLUDED.email, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, google_sub = EXCLUDED.google_sub,
         gmail_access = EXCLUDED.gmail_access, drive_access = EXCLUDED.drive_access, scopes = EXCLUDED.scopes,
         refresh_token = EXCLUDED.refresh_token, connected_by = EXCLUDED.connected_by,
         last_check_at = NULL, last_check_ok = NULL, last_check_error = NULL, updated_at = now()
       RETURNING *`,
      [projectId, input.email, input.name, input.avatarUrl, input.googleSub, input.gmailAccess, input.driveAccess, JSON.stringify(input.scopes), input.refreshToken, input.connectedById],
    );
    return toAccount(rows[0]);
  },

  async recordCheck(projectId: string, ok: boolean, error: string | null): Promise<void> {
    await pool.query('UPDATE project_google_accounts SET last_check_at = now(), last_check_ok = $2, last_check_error = $3 WHERE project_id = $1', [projectId, ok, error]);
  },

  async delete(projectId: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM project_google_accounts WHERE project_id = $1', [projectId]);
    return (rowCount ?? 0) > 0;
  },
};
