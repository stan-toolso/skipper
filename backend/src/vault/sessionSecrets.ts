import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import { log } from '../log.js';
import { openSecrets, sealSecrets } from './crypto.js';

/**
 * Secrets éphémères d'une session : saisis par une personne dans la modale de `request_secrets` (choix « pour cette
 * session seulement »), ils ne vont pas dans le coffre. Chiffrés en base (clé de données propre, enveloppée par la clé
 * maîtresse : `crypto.ts`), lisibles seulement par les outils du coffre de cette session, sous la référence
 * `session:<nom>.<champ>`. Effacés à l'archivage de la session, à sa suppression (cascade) ou à expiration.
 */
export const SESSION_SECRET_TTL_MS = 24 * 60 * 60 * 1000;
/** Préfixe des références d'un secret de session (`session:cle.token`). */
export const SESSION_REF_PREFIX = 'session:';
/** « Type » lié au chiffré (données authentifiées) : un chiffré du coffre ne se lit pas comme un secret de session. */
const KIND = 'session_secret';

export interface SessionSecretField {
  key: string;
  label: string;
}

export interface SessionSecret {
  id: string;
  sessionId: string;
  name: string;
  fields: SessionSecretField[];
  requireApproval: boolean;
  createdById: string | null;
  createdAt: Date;
  expiresAt: Date;
}

interface Row {
  id: string;
  session_id: string;
  name: string;
  fields: SessionSecretField[];
  secret_ciphertext: string;
  wrapped_key: string;
  require_approval: boolean;
  created_by_id: string | null;
  created_at: Date;
  expires_at: Date;
}

const toSecret = (r: Row): SessionSecret => ({
  id: r.id,
  sessionId: r.session_id,
  name: r.name,
  fields: r.fields ?? [],
  requireApproval: r.require_approval,
  createdById: r.created_by_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

export const sessionSecretService = {
  /** Crée ou remplace le secret `name` de la session (les champs saisis remplacent les précédents, les autres restent). */
  async store(input: { sessionId: string; name: string; fields: SessionSecretField[]; values: Record<string, string>; requireApproval: boolean; createdById: string | null }): Promise<SessionSecret> {
    const current = await this.find(input.sessionId, input.name);
    const previous = current ? await this.values(current.sessionId, current.name) : {};
    const values = { ...previous, ...input.values };
    const fields = [...(current?.fields ?? []).filter((f) => !(f.key in input.values)), ...input.fields];
    const id = current?.id ?? randomUUID();
    const sealed = sealSecrets(id, KIND, values);
    const { rows } = await pool.query<Row>(
      `INSERT INTO session_secrets (id, session_id, name, fields, secret_ciphertext, wrapped_key, require_approval, created_by_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (session_id, name) DO UPDATE SET fields = EXCLUDED.fields, secret_ciphertext = EXCLUDED.secret_ciphertext,
         wrapped_key = EXCLUDED.wrapped_key, require_approval = EXCLUDED.require_approval, created_by_id = EXCLUDED.created_by_id,
         expires_at = EXCLUDED.expires_at
       RETURNING *`,
      [id, input.sessionId, input.name, toJson(fields), sealed.secretCiphertext, sealed.wrappedKey, input.requireApproval, input.createdById, new Date(Date.now() + SESSION_SECRET_TTL_MS)],
    );
    return toSecret(rows[0]);
  },

  /** Secret encore valable de la session (null s'il n'existe pas ou a expiré). */
  async find(sessionId: string, name: string): Promise<SessionSecret | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM session_secrets WHERE session_id = $1 AND name = $2 AND expires_at > now()', [sessionId, name]);
    return rows[0] ? toSecret(rows[0]) : null;
  },

  async list(sessionId: string): Promise<SessionSecret[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM session_secrets WHERE session_id = $1 AND expires_at > now() ORDER BY name', [sessionId]);
    return rows.map(toSecret);
  },

  /** Valeurs déchiffrées (usage par le serveur seul). */
  async values(sessionId: string, name: string): Promise<Record<string, string>> {
    const { rows } = await pool.query<Row>('SELECT * FROM session_secrets WHERE session_id = $1 AND name = $2 AND expires_at > now()', [sessionId, name]);
    if (!rows[0]) return {};
    return openSecrets(rows[0].id, KIND, rows[0].secret_ciphertext, rows[0].wrapped_key);
  },

  /** Efface les secrets d'une session (archivage). */
  async clearSession(sessionId: string): Promise<number> {
    const { rowCount } = await pool.query('DELETE FROM session_secrets WHERE session_id = $1', [sessionId]);
    return rowCount ?? 0;
  },

  async purgeExpired(): Promise<number> {
    const { rowCount } = await pool.query('DELETE FROM session_secrets WHERE expires_at <= now()');
    return rowCount ?? 0;
  },

  /** Purge périodique (tâche de l'instance meneuse). */
  timer: null as NodeJS.Timeout | null,
  start(): void {
    const sweep = () => void this.purgeExpired().then((n) => n && log.info(`[vault] ${n} secret(s) de session expiré(s) effacé(s)`)).catch((err) => log.warn('[vault] purge des secrets de session', err));
    sweep();
    this.timer ??= setInterval(sweep, 15 * 60_000);
  },
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  },
};
