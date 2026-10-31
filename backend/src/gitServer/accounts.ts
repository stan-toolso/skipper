import { pool } from '../db/pool.js';

/** Table forge_accounts : compte Forgejo de chaque personne et jeton (chiffré) de ses sessions. */
export const forgeAccountRepository = {
  async usernameOf(userId: string): Promise<string | null> {
    const { rows } = await pool.query<{ username: string }>('SELECT username FROM forge_accounts WHERE user_id = $1', [userId]);
    return rows[0]?.username ?? null;
  },

  async userIdOf(username: string): Promise<string | null> {
    const { rows } = await pool.query<{ user_id: string }>('SELECT user_id FROM forge_accounts WHERE lower(username) = lower($1)', [username]);
    return rows[0]?.user_id ?? null;
  },

  /** Associe un compte à la personne (le premier enregistré l'emporte) ; renvoie le compte retenu. */
  async link(userId: string, username: string): Promise<string> {
    const { rows } = await pool.query<{ username: string }>(
      'INSERT INTO forge_accounts (user_id, username) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET username = forge_accounts.username RETURNING username',
      [userId, username],
    );
    return rows[0].username;
  },

  async agentToken(userId: string): Promise<string | null> {
    const { rows } = await pool.query<{ agent_token: string | null }>('SELECT agent_token FROM forge_accounts WHERE user_id = $1', [userId]);
    return rows[0]?.agent_token ?? null;
  },

  async setAgentToken(userId: string, ciphertext: string): Promise<void> {
    await pool.query('UPDATE forge_accounts SET agent_token = $2, token_created_at = now() WHERE user_id = $1', [userId, ciphertext]);
  },
};
