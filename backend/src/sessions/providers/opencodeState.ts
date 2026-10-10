import { pool } from '../../db/pool.js';

/**
 * Miroir d'une session OpenCode dans Skipper : OpenCode garde ses sessions dans une base locale du
 * conteneur (dossier personnel en mémoire, perdu à la recréation du conteneur). Après chaque tour, la
 * session et ses messages sont enregistrés ici ; un démarrage sans base locale les réimporte
 * (`opencode import`, même format que `opencode export` : `{ info, messages: [{ info, parts }] }`).
 */

export interface OpencodeExport {
  info: Record<string, unknown>;
  messages: { info: Record<string, unknown>; parts: unknown[] }[];
}

export const opencodeStateRepository = {
  async save(sessionId: string, opencodeSessionId: string, state: OpencodeExport): Promise<void> {
    await pool.query(
      `INSERT INTO opencode_sessions (session_id, opencode_session_id, info, messages, updated_at) VALUES ($1, $2, $3::jsonb, $4::jsonb, now())
       ON CONFLICT (session_id) DO UPDATE SET opencode_session_id = EXCLUDED.opencode_session_id, info = EXCLUDED.info, messages = EXCLUDED.messages, updated_at = now()`,
      [sessionId, opencodeSessionId, JSON.stringify(state.info), JSON.stringify(state.messages)],
    );
  },

  async load(sessionId: string, opencodeSessionId: string): Promise<OpencodeExport | null> {
    const { rows } = await pool.query<{ info: Record<string, unknown>; messages: OpencodeExport['messages'] }>('SELECT info, messages FROM opencode_sessions WHERE session_id = $1 AND opencode_session_id = $2', [sessionId, opencodeSessionId]);
    return rows[0] ? { info: rows[0].info, messages: rows[0].messages ?? [] } : null;
  },
};
