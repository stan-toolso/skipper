import { pool } from '../db/pool.js';

/** Stockage clé/valeur JSON des réglages de l'application. */
export const settingsRepository = {
  async get<T>(key: string): Promise<T | null> {
    const { rows } = await pool.query<{ value: T }>('SELECT value FROM app_settings WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  },

  async set<T>(key: string, value: T): Promise<void> {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  },

  async delete(key: string): Promise<void> {
    await pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
  },
};
