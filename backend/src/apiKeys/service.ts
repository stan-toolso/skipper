import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { AppError, NotFoundError } from '../errors.js';
import type { ProjectApiKey } from '../tasks/types.js';

/**
 * Clés d'API d'un projet pour l'API REST des tâches : `skp_` suivi de 40 caractères ; seul le hachage
 * est conservé, le secret n'est montré qu'à la création. Supprimer une clé la révoque aussitôt.
 */

const PREFIX = 'skp_';
const MAX_KEYS = 20;
const LAST_USED_THROTTLE_MS = 60_000;

interface Row {
  id: string;
  project_id: string;
  name: string;
  key_prefix: string;
  created_by: string | null;
  created_at: Date;
  last_used_at: Date | null;
}
const toKey = (r: Row): ProjectApiKey => ({ id: r.id, projectId: r.project_id, name: r.name, prefix: r.key_prefix, createdById: r.created_by, createdAt: r.created_at, lastUsedAt: r.last_used_at });

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const lastUsedWritten = new Map<string, number>();

export const apiKeyService = {
  async list(projectId: string): Promise<ProjectApiKey[]> {
    const { rows } = await pool.query<Row>('SELECT id, project_id, name, key_prefix, created_by, created_at, last_used_at FROM project_api_keys WHERE project_id = $1 ORDER BY created_at', [projectId]);
    return rows.map(toKey);
  },

  async get(id: string): Promise<ProjectApiKey> {
    const { rows } = await pool.query<Row>('SELECT id, project_id, name, key_prefix, created_by, created_at, last_used_at FROM project_api_keys WHERE id = $1', [id]);
    if (!rows[0]) throw new NotFoundError("Clé d'API introuvable");
    return toKey(rows[0]);
  },

  /** Crée une clé ; le secret complet n'est renvoyé que cette fois. */
  async create(projectId: string, name: string, createdBy: string): Promise<{ key: ProjectApiKey; secret: string }> {
    const label = name.trim();
    if (!label) throw new AppError('Le nom de la clé est obligatoire');
    if (label.length > 100) throw new AppError('Le nom de la clé dépasse 100 caractères');
    if ((await this.list(projectId)).length >= MAX_KEYS) throw new AppError(`Au plus ${MAX_KEYS} clés d'API par projet`);
    const secret = `${PREFIX}${randomBytes(30).toString('base64url')}`;
    const { rows } = await pool.query<Row>(
      `INSERT INTO project_api_keys (project_id, name, key_prefix, key_hash, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, project_id, name, key_prefix, created_by, created_at, last_used_at`,
      [projectId, label, secret.slice(0, PREFIX.length + 8), hash(secret), createdBy],
    );
    return { key: toKey(rows[0]), secret };
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM project_api_keys WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  /** Clé correspondant à un secret, ou null ; la dernière utilisation est notée au plus une fois par minute. */
  async authenticate(secret: string): Promise<ProjectApiKey | null> {
    if (!secret.startsWith(PREFIX)) return null;
    const { rows } = await pool.query<Row>('SELECT id, project_id, name, key_prefix, created_by, created_at, last_used_at FROM project_api_keys WHERE key_hash = $1', [hash(secret)]);
    if (!rows[0]) return null;
    const key = toKey(rows[0]);
    const now = Date.now();
    if (now - (lastUsedWritten.get(key.id) ?? 0) > LAST_USED_THROTTLE_MS) {
      lastUsedWritten.set(key.id, now);
      void pool.query('UPDATE project_api_keys SET last_used_at = now() WHERE id = $1', [key.id]).catch(() => undefined);
    }
    return key;
  },
};
