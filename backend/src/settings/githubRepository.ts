import { pool } from '../db/pool.js';

/** Compte GitHub connecté par une personne (`user_github_accounts`) ; son jeton vit dans l'élément du coffre `vaultItemId`. */
export interface GithubAccountRecord {
  id: string;
  userId: string;
  login: string;
  avatarUrl: string | null;
  method: 'oauth' | 'pat';
  vaultItemId: string;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
  organizations: string[];
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface GithubAccountInput {
  login: string;
  avatarUrl: string | null;
  method: 'oauth' | 'pat';
  /** Élément du coffre (jeton applicatif 'github') qui détient le jeton. */
  vaultItemId: string;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
  organizations: string[];
}

interface Row {
  id: string;
  user_id: string;
  login: string;
  avatar_url: string | null;
  method: 'oauth' | 'pat';
  vault_item_id: string;
  token_expires_at: Date | null;
  refresh_token_expires_at: Date | null;
  scopes: string[];
  organizations: string[];
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

const toAccount = (r: Row): GithubAccountRecord => ({
  id: r.id,
  userId: r.user_id,
  login: r.login,
  avatarUrl: r.avatar_url,
  method: r.method,
  vaultItemId: r.vault_item_id,
  tokenExpiresAt: r.token_expires_at,
  refreshTokenExpiresAt: r.refresh_token_expires_at,
  scopes: r.scopes ?? [],
  organizations: r.organizations ?? [],
  isDefault: r.is_default,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const githubAccountRepository = {
  async listByUser(userId: string): Promise<GithubAccountRecord[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM user_github_accounts WHERE user_id = $1 ORDER BY is_default DESC, created_at, login', [userId]);
    return rows.map(toAccount);
  },

  async findById(userId: string, id: string): Promise<GithubAccountRecord | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM user_github_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
    return rows[0] ? toAccount(rows[0]) : null;
  },

  /** Crée le compte, ou remplace le jeton du même identifiant (reconnexion). Le premier compte d'une personne devient son compte par défaut. */
  async upsert(userId: string, input: GithubAccountInput): Promise<GithubAccountRecord> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO user_github_accounts (user_id, login, avatar_url, method, vault_item_id, token_expires_at, refresh_token_expires_at, scopes, organizations, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOT EXISTS (SELECT 1 FROM user_github_accounts WHERE user_id = $1))
       ON CONFLICT (user_id, lower(login)) DO UPDATE SET
         login = EXCLUDED.login, avatar_url = EXCLUDED.avatar_url, method = EXCLUDED.method, vault_item_id = EXCLUDED.vault_item_id,
         token_expires_at = EXCLUDED.token_expires_at, refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
         scopes = EXCLUDED.scopes, organizations = EXCLUDED.organizations, updated_at = now()
       RETURNING *`,
      [userId, input.login, input.avatarUrl, input.method, input.vaultItemId, input.tokenExpiresAt, input.refreshTokenExpiresAt, input.scopes, input.organizations],
    );
    return toAccount(rows[0]);
  },

  /** Expiration du nouveau couple de jetons après un renouvellement (les jetons eux-mêmes sont dans le coffre). */
  async updateExpiry(id: string, t: Pick<GithubAccountInput, 'tokenExpiresAt' | 'refreshTokenExpiresAt'>): Promise<void> {
    await pool.query('UPDATE user_github_accounts SET token_expires_at = $2, refresh_token_expires_at = $3, updated_at = now() WHERE id = $1', [id, t.tokenExpiresAt, t.refreshTokenExpiresAt]);
  },

  async setDefault(userId: string, id: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE user_github_accounts SET is_default = false WHERE user_id = $1 AND is_default AND id <> $2', [userId, id]);
      await client.query('UPDATE user_github_accounts SET is_default = true, updated_at = now() WHERE user_id = $1 AND id = $2', [userId, id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /** Retire le compte ; s'il était le compte par défaut, le plus ancien restant prend le relais. */
  async delete(userId: string, id: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_github_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
      await client.query(
        `UPDATE user_github_accounts SET is_default = true
         WHERE id = (SELECT id FROM user_github_accounts WHERE user_id = $1 ORDER BY created_at LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM user_github_accounts WHERE user_id = $1 AND is_default)`,
        [userId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};
