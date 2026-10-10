import { pool } from '../db/pool.js';

/**
 * Stockage clé/valeur JSON des réglages d'UNE personne (`user_settings`) : son compte Claude (réglages,
 * vérification), ses réglages OpenCode (clés choisies, modèle par défaut, liste des modèles). Chaque accès
 * est borné par l'identifiant de la personne : rien n'est lisible d'une personne à l'autre, administrateurs
 * compris. Les réglages de l'application restent dans `app_settings` (settings/repository.ts).
 */
export const userSettingsStore = {
  async get<T>(userId: string, key: string): Promise<T | null> {
    const { rows } = await pool.query<{ value: T }>('SELECT value FROM user_settings WHERE user_id = $1 AND key = $2', [userId, key]);
    return rows[0]?.value ?? null;
  },

  async set<T>(userId: string, key: string, value: T): Promise<void> {
    await pool.query(
      `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [userId, key, JSON.stringify(value)],
    );
  },

  async delete(userId: string, key: string): Promise<void> {
    await pool.query('DELETE FROM user_settings WHERE user_id = $1 AND key = $2', [userId, key]);
  },
};
