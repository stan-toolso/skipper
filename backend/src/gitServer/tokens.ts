import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { AppError, NotFoundError } from '../errors.js';
import { decryptSecret, encryptSecret } from '../settings/crypto.js';

/**
 * Jetons d'accès aux dépôts git hébergés : le mot de passe de l'authentification HTTP basic (le nom d'utilisateur est
 * ignoré). Un jeton appartient à une personne et donne ses droits sur chaque projet (lecteur : lecture seule).
 * - `agent` : un seul par personne, créé à la demande et gardé chiffré, que Skipper transmet à ses sessions et terminaux ;
 * - `personal` : créés par la personne pour ses propres clones, montrés une seule fois (hachage conservé).
 */
export interface GitAccessToken {
  id: string;
  userId: string;
  kind: 'agent' | 'personal';
  label: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}

interface Row {
  id: string;
  user_id: string;
  kind: 'agent' | 'personal';
  label: string;
  token_prefix: string;
  token_ciphertext: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
}

export const GIT_TOKEN_PREFIX = 'skgit_';
const COLUMNS = 'id, user_id, kind, label, token_prefix, token_ciphertext, created_at, last_used_at, expires_at';
const MAX_PERSONAL = 20;
const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedWritten = new Map<string, number>();

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const newSecret = () => `${GIT_TOKEN_PREFIX}${randomBytes(30).toString('base64url')}`;
const prefixOf = (secret: string) => secret.slice(0, GIT_TOKEN_PREFIX.length + 6);
const toToken = (r: Row): GitAccessToken => ({ id: r.id, userId: r.user_id, kind: r.kind, label: r.label, prefix: r.token_prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at });

export const gitTokenService = {
  /** Jetons personnels d'une personne (le jeton d'agent n'est pas listé : il n'est pas à elle de le gérer). */
  async listPersonal(userId: string): Promise<GitAccessToken[]> {
    const { rows } = await pool.query<Row>(`SELECT ${COLUMNS} FROM git_access_tokens WHERE user_id = $1 AND kind = 'personal' ORDER BY created_at DESC`, [userId]);
    return rows.map(toToken);
  },

  /** Crée un jeton personnel ; le secret complet n'est renvoyé que cette fois. `expiresInDays` null : sans expiration. */
  async createPersonal(userId: string, label: string, expiresInDays: number | null): Promise<{ token: GitAccessToken; secret: string }> {
    const name = label.trim();
    if (!name) throw new AppError('Le libellé du jeton est obligatoire');
    if (name.length > 100) throw new AppError('Le libellé du jeton dépasse 100 caractères');
    if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)) throw new AppError('Durée de validité : entre 1 et 3650 jours, ou aucune');
    if ((await this.listPersonal(userId)).length >= MAX_PERSONAL) throw new AppError(`Au plus ${MAX_PERSONAL} jetons d'accès git par personne`);
    const secret = newSecret();
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null;
    const { rows } = await pool.query<Row>(
      `INSERT INTO git_access_tokens (user_id, kind, label, token_prefix, token_hash, expires_at) VALUES ($1, 'personal', $2, $3, $4, $5) RETURNING ${COLUMNS}`,
      [userId, name, prefixOf(secret), hash(secret), expiresAt],
    );
    return { token: toToken(rows[0]), secret };
  },

  /** Révoque un jeton personnel de la personne (jamais celui d'une autre). */
  async revoke(userId: string, id: string): Promise<boolean> {
    const { rowCount } = await pool.query(`DELETE FROM git_access_tokens WHERE id = $1 AND user_id = $2 AND kind = 'personal'`, [id, userId]);
    if (!rowCount) throw new NotFoundError('Jeton introuvable');
    return true;
  },

  /**
   * Le jeton d'agent de la personne, créé au premier appel : celui que ses sessions et terminaux reçoivent pour pousser
   * sur les dépôts hébergés. Gardé chiffré (clé des secrets du coffre) pour pouvoir être redonné à chaque lancement.
   */
  async agentToken(userId: string): Promise<string> {
    const existing = await pool.query<Row>(`SELECT ${COLUMNS} FROM git_access_tokens WHERE user_id = $1 AND kind = 'agent'`, [userId]);
    if (existing.rows[0]?.token_ciphertext) return decryptSecret(existing.rows[0].token_ciphertext);
    const secret = newSecret();
    // Deux lancements simultanés : le second perd la course et relit celui du premier (index unique par personne).
    const inserted = await pool.query<Row>(
      `INSERT INTO git_access_tokens (user_id, kind, label, token_prefix, token_hash, token_ciphertext) VALUES ($1, 'agent', 'Sessions et terminaux', $2, $3, $4)
       ON CONFLICT (user_id) WHERE kind = 'agent' DO NOTHING RETURNING ${COLUMNS}`,
      [userId, prefixOf(secret), hash(secret), encryptSecret(secret)],
    );
    if (inserted.rows[0]) return secret;
    const again = await pool.query<Row>(`SELECT ${COLUMNS} FROM git_access_tokens WHERE user_id = $1 AND kind = 'agent'`, [userId]);
    if (!again.rows[0]?.token_ciphertext) throw new AppError("Le jeton d'agent n'a pas pu être créé");
    return decryptSecret(again.rows[0].token_ciphertext);
  },

  /** Renouvelle le jeton d'agent de la personne (l'ancien cesse de valoir ; les sessions en cours gardent l'ancien jusqu'à leur prochain lancement). */
  async rotateAgentToken(userId: string): Promise<void> {
    await pool.query(`DELETE FROM git_access_tokens WHERE user_id = $1 AND kind = 'agent'`, [userId]);
  },

  /** Personne à qui appartient un secret valide (non expiré), ou null ; la dernière utilisation est notée au plus une fois par minute. */
  async authenticate(secret: string): Promise<{ userId: string; token: GitAccessToken } | null> {
    if (!secret.startsWith(GIT_TOKEN_PREFIX)) return null;
    const { rows } = await pool.query<Row>(`SELECT ${COLUMNS} FROM git_access_tokens WHERE token_hash = $1`, [hash(secret)]);
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return null;
    const now = Date.now();
    if (now - (lastUsedWritten.get(row.id) ?? 0) > LAST_USED_THROTTLE_MS) {
      lastUsedWritten.set(row.id, now);
      void pool.query('UPDATE git_access_tokens SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => undefined);
    }
    return { userId: row.user_id, token: toToken(row) };
  },

  /** Supprime les jetons expirés (au démarrage et à chaque passage de la sauvegarde de fond). */
  async purgeExpired(): Promise<number> {
    const { rowCount } = await pool.query('DELETE FROM git_access_tokens WHERE expires_at IS NOT NULL AND expires_at < now()');
    return rowCount ?? 0;
  },
};
