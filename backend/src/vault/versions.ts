import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { VaultItem, VaultSettings } from './types.js';

/**
 * Historique des versions d'un élément du coffre (table vault_item_versions). Chaque modification faite par une
 * personne ou une session (création, mise à jour, nouvelle paire de clés, restauration) fige l'état complet de
 * l'élément, secrets compris : le chiffré et la clé enveloppée sont recopiés tels quels (liés à l'identifiant de
 * l'élément, ils restent lisibles et se ré-enveloppent à la rotation de la clé maîtresse comme l'élément).
 * Les renouvellements automatiques de jetons n'y entrent pas.
 */

export const VERSIONS_KEPT = 100;

/** Une différence entre deux versions ; jamais de valeur secrète (`secret` : seule la présence d'un changement). */
export interface VaultChange {
  field: string;
  label: string;
  before?: string | null;
  after?: string | null;
  secret?: boolean;
}

export interface VaultItemVersion {
  id: string;
  itemId: string;
  version: number;
  action: string;
  name: string;
  description: string;
  settings: VaultSettings;
  secretCiphertext: string | null;
  wrappedKey: string | null;
  publicKey: string | null;
  readOnly: boolean;
  requireApproval: boolean;
  envExport: boolean;
  commandAllowlist: string[];
  expiresAt: Date | null;
  changes: VaultChange[];
  restoredFrom: number | null;
  actorUserId: string | null;
  sessionId: string | null;
  projectId: string | null;
  createdAt: Date;
}

/** Ce que fige une version (les colonnes de l'élément qui se modifient à la main). */
export type VaultSnapshot = Pick<
  VaultItem,
  'name' | 'description' | 'settings' | 'secretCiphertext' | 'wrappedKey' | 'publicKey' | 'readOnly' | 'requireApproval' | 'envExport' | 'commandAllowlist' | 'expiresAt'
>;

interface Row {
  id: string;
  item_id: string;
  version: number;
  action: string;
  name: string;
  description: string;
  settings: VaultSettings;
  secret_ciphertext: string | null;
  wrapped_key: string | null;
  public_key: string | null;
  read_only: boolean;
  require_approval: boolean;
  env_export: boolean;
  command_allowlist: string[];
  expires_at: Date | null;
  changes: VaultChange[];
  restored_from: number | null;
  actor_user_id: string | null;
  session_id: string | null;
  project_id: string | null;
  created_at: Date;
}

const toVersion = (r: Row): VaultItemVersion => ({
  id: String(r.id),
  itemId: r.item_id,
  version: r.version,
  action: r.action,
  name: r.name,
  description: r.description,
  settings: r.settings ?? ({} as VaultSettings),
  secretCiphertext: r.secret_ciphertext,
  wrappedKey: r.wrapped_key,
  publicKey: r.public_key,
  readOnly: r.read_only,
  requireApproval: r.require_approval,
  envExport: r.env_export,
  commandAllowlist: Array.isArray(r.command_allowlist) ? r.command_allowlist : [],
  expiresAt: r.expires_at,
  changes: Array.isArray(r.changes) ? r.changes : [],
  restoredFrom: r.restored_from,
  actorUserId: r.actor_user_id,
  sessionId: r.session_id,
  projectId: r.project_id,
  createdAt: r.created_at,
});

export interface NewVersion {
  itemId: string;
  action: string;
  snapshot: VaultSnapshot;
  changes: VaultChange[];
  restoredFrom?: number | null;
  actorUserId: string | null;
  sessionId: string | null;
  projectId: string | null;
}

export const versionRepository = {
  /** Ajoute une version (numéro suivant) et élague au-delà des VERSIONS_KEPT dernières. */
  async add(v: NewVersion): Promise<VaultItemVersion> {
    const s = v.snapshot;
    const { rows } = await pool.query<Row>(
      `INSERT INTO vault_item_versions (item_id, version, action, name, description, settings, secret_ciphertext, wrapped_key, public_key, read_only,
                                        require_approval, env_export, command_allowlist, expires_at, changes, restored_from, actor_user_id, session_id, project_id)
       VALUES ($1, COALESCE((SELECT max(version) FROM vault_item_versions WHERE item_id = $1), 0) + 1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9,
               $10, $11, $12::jsonb, $13, $14::jsonb, $15, $16, $17, $18)
       RETURNING *`,
      [
        v.itemId,
        v.action,
        s.name,
        s.description,
        toJson(s.settings),
        s.secretCiphertext,
        s.wrappedKey,
        s.publicKey,
        s.readOnly,
        s.requireApproval,
        s.envExport,
        toJson(s.commandAllowlist),
        s.expiresAt,
        toJson(v.changes),
        v.restoredFrom ?? null,
        v.actorUserId,
        v.sessionId,
        v.projectId,
      ],
    );
    await pool.query(
      `DELETE FROM vault_item_versions WHERE item_id = $1 AND version <= (SELECT max(version) FROM vault_item_versions WHERE item_id = $1) - $2`,
      [v.itemId, VERSIONS_KEPT],
    );
    return toVersion(rows[0]);
  },

  async latest(itemId: string): Promise<VaultItemVersion | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM vault_item_versions WHERE item_id = $1 ORDER BY version DESC LIMIT 1', [itemId]);
    return rows[0] ? toVersion(rows[0]) : null;
  },

  async find(itemId: string, version: number): Promise<VaultItemVersion | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM vault_item_versions WHERE item_id = $1 AND version = $2', [itemId, version]);
    return rows[0] ? toVersion(rows[0]) : null;
  },

  async list(itemId: string, limit: number, before?: number | null): Promise<VaultItemVersion[]> {
    const params: unknown[] = [itemId, Math.min(Math.max(limit, 1), VERSIONS_KEPT)];
    const beforeSql = before ? `AND version < $${params.push(before)}` : '';
    const { rows } = await pool.query<Row>(`SELECT * FROM vault_item_versions WHERE item_id = $1 ${beforeSql} ORDER BY version DESC LIMIT $2`, params);
    return rows.map(toVersion);
  },

  /** Versions dont la clé de données est enveloppée par une autre clé maîtresse que la courante. */
  async listToRewrap(currentKeyId: string): Promise<Pick<VaultItemVersion, 'id' | 'itemId' | 'wrappedKey'>[]> {
    const { rows } = await pool.query<{ id: string; item_id: string; wrapped_key: string }>(
      `SELECT id, item_id, wrapped_key FROM vault_item_versions WHERE wrapped_key IS NOT NULL AND split_part(wrapped_key, ':', 2) <> $1`,
      [currentKeyId],
    );
    return rows.map((r) => ({ id: String(r.id), itemId: r.item_id, wrappedKey: r.wrapped_key }));
  },

  async replaceWrappedKey(id: string, wrappedKey: string, expected: string): Promise<boolean> {
    const { rowCount } = await pool.query('UPDATE vault_item_versions SET wrapped_key = $2 WHERE id = $1 AND wrapped_key = $3', [id, wrappedKey, expected]);
    return (rowCount ?? 0) > 0;
  },
};

export const snapshotOf = (item: VaultSnapshot): VaultSnapshot => ({
  name: item.name,
  description: item.description,
  settings: item.settings,
  secretCiphertext: item.secretCiphertext,
  wrappedKey: item.wrappedKey,
  publicKey: item.publicKey,
  readOnly: item.readOnly,
  requireApproval: item.requireApproval,
  envExport: item.envExport,
  commandAllowlist: item.commandAllowlist,
  expiresAt: item.expiresAt,
});

/** Réglages qui changent tout seuls (renouvellement, identité constatée) : hors historique des différences. */
const VOLATILE_SETTINGS = new Set(['tokenExpiresAt', 'refreshExpiresAt', 'identity', 'expiresAt', 'connectedAt']);

/** Secrets renouvelés par Skipper lui-même (jetons Identity Center, inscription OIDC) : hors différences. */
const VOLATILE_SECRETS = new Set(['accessToken', 'refreshToken', 'clientId', 'clientSecret']);

const SETTING_LABELS: Record<string, string> = {
  host: 'hôte',
  port: 'port',
  username: 'utilisateur',
  database: 'base',
  ssl: 'TLS',
  sslCa: "certificat d'autorité",
  viaItemId: 'tunnel SSH',
  baseUrl: 'adresse de base',
  url: 'adresse',
  authScheme: 'authentification',
  authName: 'nom du jeton',
  region: 'région',
  zone: 'zone',
  auth: "mode d'authentification",
  accessKeyId: "clé d'accès",
  accessKey: "clé d'accès",
  roleArn: 'rôle',
  roleName: 'rôle',
  accountId: 'compte',
  organizationId: 'organisation',
  projectId: 'projet',
  startUrl: "portail d'accès",
};

const SECRET_LABELS: Record<string, string> = {
  privateKey: 'clé privée',
  password: 'mot de passe',
  token: 'jeton',
  secretKey: 'clé secrète',
  secretAccessKey: 'clé secrète',
};

const show = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…` : v;
  return JSON.stringify(v);
};

interface FieldLike {
  key: string;
  label?: string;
  secret?: boolean;
  value?: string | null;
}

/**
 * Différences entre deux états d'un élément. Les secrets sont comparés en clair (déchiffrés par l'appelant),
 * mais seule la clé du secret modifié apparaît, jamais sa valeur.
 */
export function diffSnapshots(
  before: VaultSnapshot | null,
  after: VaultSnapshot,
  secretsBefore: Record<string, string>,
  secretsAfter: Record<string, string>,
): VaultChange[] {
  const changes: VaultChange[] = [];
  const push = (field: string, label: string, a: unknown, b: unknown) => {
    const x = show(a);
    const y = show(b);
    if (x !== y) changes.push({ field, label, before: x, after: y });
  };
  if (!before) return [];
  push('name', 'nom', before.name, after.name);
  push('description', 'description', before.description, after.description);
  const sa = (before.settings ?? {}) as unknown as Record<string, unknown>;
  const sb = (after.settings ?? {}) as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].filter((k) => !VOLATILE_SETTINGS.has(k) && k !== 'fields');
  for (const k of keys) push(`settings.${k}`, SETTING_LABELS[k] ?? k, sa[k], sb[k]);
  const fa = new Map(((sa.fields as FieldLike[] | undefined) ?? []).map((f) => [f.key, f]));
  const fb = new Map(((sb.fields as FieldLike[] | undefined) ?? []).map((f) => [f.key, f]));
  const fieldSecrets = new Set<string>();
  for (const key of new Set([...fa.keys(), ...fb.keys()])) {
    const a = fa.get(key);
    const b = fb.get(key);
    const label = `champ « ${b?.label ?? a?.label ?? key} »`;
    if (a?.secret || b?.secret) fieldSecrets.add(key);
    if (!a) changes.push({ field: `fields.${key}`, label, before: null, after: b!.secret ? null : show(b!.value), ...(b!.secret ? { secret: true } : {}) });
    else if (!b) changes.push({ field: `fields.${key}`, label, before: a.secret ? null : show(a.value), after: null, ...(a.secret ? { secret: true } : {}) });
    else if (Boolean(a.secret) !== Boolean(b.secret)) changes.push({ field: `fields.${key}`, label, before: a.secret ? 'secret' : 'public', after: b.secret ? 'secret' : 'public' });
    else if (!a.secret) push(`fields.${key}`, label, a.value, b.value);
    else if (secretsBefore[key] !== secretsAfter[key]) changes.push({ field: `fields.${key}`, label, secret: true });
    if (a && b && (a.label ?? '') !== (b.label ?? '') && !changes.some((c) => c.field === `fields.${key}`)) push(`fields.${key}.label`, `libellé du champ « ${key} »`, a.label, b.label);
  }
  for (const key of new Set([...Object.keys(secretsBefore), ...Object.keys(secretsAfter)])) {
    if (fieldSecrets.has(key) || VOLATILE_SECRETS.has(key)) continue;
    if (secretsBefore[key] !== secretsAfter[key]) changes.push({ field: `secrets.${key}`, label: SECRET_LABELS[key] ?? key, secret: true });
  }
  push('publicKey', 'clé publique', before.publicKey ? 'définie' : null, after.publicKey ? (before.publicKey === after.publicKey ? 'définie' : 'nouvelle') : null);
  push('readOnly', 'lecture seule', before.readOnly ? 'oui' : 'non', after.readOnly ? 'oui' : 'non');
  push('requireApproval', 'approbation à chaque usage', before.requireApproval ? 'oui' : 'non', after.requireApproval ? 'oui' : 'non');
  push('envExport', "fichiers d'environnement", before.envExport ? 'oui' : 'non', after.envExport ? 'oui' : 'non');
  push('commandAllowlist', 'commandes autorisées', before.commandAllowlist.join(' | '), after.commandAllowlist.join(' | '));
  push('expiresAt', 'expiration', before.expiresAt ? new Date(before.expiresAt).toISOString() : null, after.expiresAt ? new Date(after.expiresAt).toISOString() : null);
  return changes;
}
