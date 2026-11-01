import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { ProjectRole } from '../users/types.js';
import type { AccessFacts } from './access.js';
import type { ProjectVaultRow, VaultAuditEvent, VaultItem, VaultItemKind, VaultItemVia, VaultLink, VaultLinkScope, VaultPermission, VaultSettings, VaultShare } from './types.js';

interface Row {
  id: string;
  owner_user_id: string | null;
  owner_project_id: string | null;
  name: string;
  kind: VaultItemKind;
  description: string;
  settings: VaultSettings;
  secret_ciphertext: string | null;
  wrapped_key: string | null;
  legacy_secrets: Record<string, string> | null;
  public_key: string | null;
  host_key: string | null;
  host_key_seen_at: Date | null;
  read_only: boolean;
  require_approval: boolean;
  env_export: boolean;
  command_allowlist: string[];
  expires_at: Date | null;
  secret_updated_at: Date | null;
  last_test_at: Date | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const toItem = (r: Row): VaultItem => ({
  id: r.id,
  ownerUserId: r.owner_user_id,
  ownerProjectId: r.owner_project_id,
  name: r.name,
  kind: r.kind,
  description: r.description,
  settings: r.settings ?? ({} as VaultSettings),
  secretCiphertext: r.secret_ciphertext,
  wrappedKey: r.wrapped_key,
  legacySecrets: r.legacy_secrets && Object.keys(r.legacy_secrets).length ? r.legacy_secrets : null,
  publicKey: r.public_key,
  hostKey: r.host_key,
  hostKeySeenAt: r.host_key_seen_at,
  readOnly: r.read_only,
  requireApproval: r.require_approval,
  envExport: r.env_export ?? false,
  commandAllowlist: Array.isArray(r.command_allowlist) ? r.command_allowlist : [],
  expiresAt: r.expires_at,
  secretUpdatedAt: r.secret_updated_at,
  lastTestAt: r.last_test_at,
  lastTestOk: r.last_test_ok,
  lastTestError: r.last_test_error,
  createdById: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface ShareRow {
  item_id: string;
  user_id: string;
  permission: VaultPermission;
  granted_by: string | null;
  created_at: Date;
  updated_at: Date;
}
const toShare = (r: ShareRow): VaultShare => ({ itemId: r.item_id, userId: r.user_id, permission: r.permission, grantedById: r.granted_by, createdAt: r.created_at, updatedAt: r.updated_at });

interface LinkRow {
  id: string;
  item_id: string;
  project_id: string;
  scope: VaultLinkScope;
  user_id: string | null;
  linked_by: string | null;
  created_at: Date;
}
const toLink = (r: LinkRow): VaultLink => ({ id: r.id, itemId: r.item_id, projectId: r.project_id, scope: r.scope, userId: r.user_id, linkedById: r.linked_by, createdAt: r.created_at });

interface AuditRow {
  id: string;
  item_id: string | null;
  item_name: string;
  item_kind: string;
  action: string;
  actor_user_id: string | null;
  session_id: string | null;
  project_id: string | null;
  ok: boolean;
  detail: string | null;
  created_at: Date;
}
const toAudit = (r: AuditRow): VaultAuditEvent => ({
  id: String(r.id),
  itemId: r.item_id,
  itemName: r.item_name,
  itemKind: r.item_kind,
  action: r.action,
  actorUserId: r.actor_user_id,
  sessionId: r.session_id,
  projectId: r.project_id,
  ok: r.ok,
  detail: r.detail,
  createdAt: r.created_at,
});

export interface VaultItemRecord {
  id: string;
  ownerUserId: string | null;
  ownerProjectId: string | null;
  name: string;
  kind: VaultItemKind;
  description: string;
  settings: VaultSettings;
  secretCiphertext: string | null;
  wrappedKey: string | null;
  publicKey: string | null;
  hostKey?: string | null;
  hostKeySeenAt?: Date | null;
  readOnly: boolean;
  requireApproval: boolean;
  /** Valeurs utilisables dans les fichiers d'environnement des work sessions (écrites en clair, lisibles par l'agent) ; défaut : non. */
  envExport?: boolean;
  commandAllowlist: string[];
  expiresAt: Date | null;
  createdById: string | null;
}

export type VaultItemPatch = Partial<Omit<VaultItemRecord, 'id' | 'ownerUserId' | 'ownerProjectId' | 'kind' | 'createdById'>> & { legacySecrets?: null };

/** Lignes d'un élément avec la façon dont il entre dans la portée d'un projet. */
const SCOPE_SQL = `
  SELECT i.*, 'own' AS via, NULL::uuid AS link_id, NULL::text AS link_scope, NULL::uuid AS link_user_id, NULL::uuid AS link_linked_by, NULL::timestamptz AS link_created_at
    FROM vault_items i WHERE i.owner_project_id = $1
  UNION ALL
  SELECT i.*, 'project', l.id, l.scope, l.user_id, l.linked_by, l.created_at
    FROM vault_items i JOIN vault_item_links l ON l.item_id = i.id
   WHERE l.project_id = $1 AND l.scope = 'project' AND i.owner_project_id IS DISTINCT FROM $1
  UNION ALL
  SELECT i.*, 'personal', l.id, l.scope, l.user_id, l.linked_by, l.created_at
    FROM vault_items i JOIN vault_item_links l ON l.item_id = i.id
   WHERE l.project_id = $1 AND l.scope = 'personal' AND l.user_id = $2 AND i.owner_project_id IS DISTINCT FROM $1
     AND (i.owner_user_id = $2
          OR EXISTS (SELECT 1 FROM vault_item_shares s WHERE s.item_id = i.id AND s.user_id = $2)
          OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = i.owner_project_id AND m.user_id = $2 AND m.role = 'admin'))
     AND EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = $1 AND m.user_id = $2)`;

type ScopeRow = Row & { via: VaultItemVia; link_id: string | null; link_scope: VaultLinkScope | null; link_user_id: string | null; link_linked_by: string | null; link_created_at: Date | null };

const toScopeRow = (r: ScopeRow): ProjectVaultRow => ({
  item: toItem(r),
  via: r.via,
  link: r.link_id ? { id: r.link_id, itemId: r.id, projectId: '', scope: r.link_scope!, userId: r.link_user_id, linkedById: r.link_linked_by, createdAt: r.link_created_at! } : null,
});

export const vaultRepository = {
  async create(input: VaultItemRecord): Promise<VaultItem> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO vault_items (id, owner_user_id, owner_project_id, name, kind, description, settings, secret_ciphertext, wrapped_key, public_key, host_key, host_key_seen_at,
                                read_only, require_approval, command_allowlist, expires_at, secret_updated_at, created_by, env_export)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END, $17, $18) RETURNING *`,
      [
        input.id,
        input.ownerUserId,
        input.ownerProjectId,
        input.name,
        input.kind,
        input.description,
        toJson(input.settings),
        input.secretCiphertext,
        input.wrappedKey,
        input.publicKey,
        input.hostKey ?? null,
        input.hostKeySeenAt ?? null,
        input.readOnly,
        input.requireApproval,
        toJson(input.commandAllowlist),
        input.expiresAt,
        input.createdById,
        input.envExport ?? false,
      ],
    );
    return toItem(rows[0]);
  },

  async update(id: string, patch: VaultItemPatch): Promise<VaultItem> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown, cast = '') => sets.push(`${column} = $${params.push(value)}${cast}`);
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.settings !== undefined) set('settings', toJson(patch.settings), '::jsonb');
    if (patch.secretCiphertext !== undefined) {
      set('secret_ciphertext', patch.secretCiphertext);
      set('wrapped_key', patch.wrappedKey ?? null);
      sets.push('secret_updated_at = now()', 'legacy_secrets = NULL');
    } else if (patch.legacySecrets === null) {
      sets.push('legacy_secrets = NULL');
    }
    if (patch.publicKey !== undefined) set('public_key', patch.publicKey);
    if (patch.hostKey !== undefined) set('host_key', patch.hostKey);
    if (patch.hostKeySeenAt !== undefined) set('host_key_seen_at', patch.hostKeySeenAt);
    if (patch.readOnly !== undefined) set('read_only', patch.readOnly);
    if (patch.requireApproval !== undefined) set('require_approval', patch.requireApproval);
    if (patch.envExport !== undefined) set('env_export', patch.envExport);
    if (patch.commandAllowlist !== undefined) set('command_allowlist', toJson(patch.commandAllowlist), '::jsonb');
    if (patch.expiresAt !== undefined) set('expires_at', patch.expiresAt);
    sets.push('updated_at = now()');
    const { rows } = await pool.query<Row>(`UPDATE vault_items SET ${sets.join(', ')} WHERE id = $${params.push(id)} RETURNING *`, params);
    return toItem(rows[0]);
  },

  /** Remplace le matériel de chiffrement sans toucher updated_at (conversion, rotation) ; conditionnel à l'état lu. */
  async replaceKeyMaterial(id: string, secretCiphertext: string | null, wrappedKey: string | null, expectedWrappedKey: string | null): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE vault_items SET secret_ciphertext = $2, wrapped_key = $3, legacy_secrets = NULL, secret_updated_at = COALESCE(secret_updated_at, now())
       WHERE id = $1 AND wrapped_key IS NOT DISTINCT FROM $4`,
      [id, secretCiphertext, wrappedKey, expectedWrappedKey],
    );
    return (rowCount ?? 0) > 0;
  },

  async recordTest(id: string, ok: boolean, error: string | null): Promise<void> {
    await pool.query('UPDATE vault_items SET last_test_at = now(), last_test_ok = $2, last_test_error = $3 WHERE id = $1', [id, ok, error]);
  },

  async findById(id: string): Promise<VaultItem | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM vault_items WHERE id = $1', [id]);
    return rows[0] ? toItem(rows[0]) : null;
  },

  async findByIds(ids: string[]): Promise<VaultItem[]> {
    if (!ids.length) return [];
    const { rows } = await pool.query<Row>('SELECT * FROM vault_items WHERE id = ANY($1::uuid[]) ORDER BY name', [ids]);
    return rows.map(toItem);
  },

  /** Éléments à reprendre au démarrage : secrets d'ancien format ou clé enveloppée par une autre clé maîtresse. */
  async listToReencrypt(currentKeyId: string): Promise<VaultItem[]> {
    const { rows } = await pool.query<Row>(
      `SELECT * FROM vault_items WHERE legacy_secrets IS NOT NULL OR (wrapped_key IS NOT NULL AND split_part(wrapped_key, ':', 2) <> $1)`,
      [currentKeyId],
    );
    return rows.map(toItem);
  },

  /** Tout ce qu'une personne peut voir : ses éléments, ceux partagés avec elle, ceux de ses projets, ceux reliés à ses projets. */
  async listAccessible(userId: string, kind?: VaultItemKind | VaultItemKind[] | null): Promise<VaultItem[]> {
    const params: unknown[] = [userId];
    const kinds = kind ? (Array.isArray(kind) ? kind : [kind]) : null;
    const kindFilter = kinds ? `AND i.kind = ANY($${params.push(kinds)}::text[])` : '';
    const { rows } = await pool.query<Row>(
      `SELECT i.* FROM vault_items i
       WHERE (i.owner_user_id = $1
          OR EXISTS (SELECT 1 FROM vault_item_shares s WHERE s.item_id = i.id AND s.user_id = $1)
          OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = i.owner_project_id AND m.user_id = $1)
          OR EXISTS (SELECT 1 FROM vault_item_links l JOIN project_members m ON m.project_id = l.project_id AND m.user_id = $1
                     WHERE l.item_id = i.id AND (l.scope = 'project' OR l.user_id = $1)))
         ${kindFilter}
       ORDER BY i.name ASC, i.created_at ASC`,
      params,
    );
    return rows.map(toItem);
  },

  /** Éléments appartenant à un projet. */
  async listOwnedByProject(projectId: string): Promise<VaultItem[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM vault_items WHERE owner_project_id = $1 ORDER BY name', [projectId]);
    return rows.map(toItem);
  },

  /** Éléments appartenant à un utilisateur. */
  async listOwnedByUser(userId: string): Promise<VaultItem[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM vault_items WHERE owner_user_id = $1 ORDER BY name', [userId]);
    return rows.map(toItem);
  },

  /** Portée d'une session : éléments du projet, reliés au projet, reliés par la personne pour ses sessions. */
  async listForAgents(projectId: string, ownerId: string | null): Promise<ProjectVaultRow[]> {
    const { rows } = await pool.query<ScopeRow>(SCOPE_SQL, [projectId, ownerId]);
    return rows.map((r) => ({ ...toScopeRow(r), link: r.link_id ? { ...toScopeRow(r).link!, projectId } : null }));
  },

  async facts(item: VaultItem, userId: string): Promise<AccessFacts> {
    const { rows } = await pool.query<{ share: VaultPermission | null; role: ProjectRole | null; linked: boolean }>(
      `SELECT (SELECT permission FROM vault_item_shares WHERE item_id = $1 AND user_id = $2) AS share,
              (SELECT role FROM project_members WHERE project_id = $3 AND user_id = $2) AS role,
              EXISTS (SELECT 1 FROM vault_item_links l JOIN project_members m ON m.project_id = l.project_id AND m.user_id = $2
                      WHERE l.item_id = $1 AND (l.scope = 'project' OR l.user_id = $2)) AS linked`,
      [item.id, userId, item.ownerProjectId],
    );
    return { share: rows[0]?.share ?? null, ownerProjectRole: rows[0]?.role ?? null, linked: Boolean(rows[0]?.linked) };
  },

  /** Éléments qui traversent l'élément SSH donné (tunnel). */
  async listDependents(viaItemId: string): Promise<VaultItem[]> {
    const { rows } = await pool.query<Row>(`SELECT * FROM vault_items WHERE kind = 'postgres' AND settings->>'viaItemId' = $1 ORDER BY name`, [viaItemId]);
    return rows.map(toItem);
  },

  async findGoogleBySub(ownerUserId: string | null, ownerProjectId: string | null, googleSub: string): Promise<VaultItem | null> {
    const { rows } = await pool.query<Row>(
      `SELECT * FROM vault_items WHERE kind = 'google' AND settings->>'googleSub' = $1 AND owner_user_id IS NOT DISTINCT FROM $2 AND owner_project_id IS NOT DISTINCT FROM $3`,
      [googleSub, ownerUserId, ownerProjectId],
    );
    return rows[0] ? toItem(rows[0]) : null;
  },

  async countGoogleBySub(googleSub: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM vault_items WHERE kind = 'google' AND settings->>'googleSub' = $1`, [googleSub]);
    return Number(rows[0].n);
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM vault_items WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  // ---- Partages ---------------------------------------------------------------------------------

  async listShares(itemId: string): Promise<VaultShare[]> {
    const { rows } = await pool.query<ShareRow>('SELECT * FROM vault_item_shares WHERE item_id = $1 ORDER BY created_at', [itemId]);
    return rows.map(toShare);
  },

  async upsertShare(itemId: string, userId: string, permission: VaultPermission, grantedBy: string | null): Promise<VaultShare> {
    const { rows } = await pool.query<ShareRow>(
      `INSERT INTO vault_item_shares (item_id, user_id, permission, granted_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (item_id, user_id) DO UPDATE SET permission = EXCLUDED.permission, granted_by = EXCLUDED.granted_by, updated_at = now() RETURNING *`,
      [itemId, userId, permission, grantedBy],
    );
    return toShare(rows[0]);
  },

  async deleteShare(itemId: string, userId: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM vault_item_shares WHERE item_id = $1 AND user_id = $2', [itemId, userId]);
    return (rowCount ?? 0) > 0;
  },

  // ---- Liens ------------------------------------------------------------------------------------

  async listLinks(itemId: string): Promise<VaultLink[]> {
    const { rows } = await pool.query<LinkRow>('SELECT * FROM vault_item_links WHERE item_id = $1 ORDER BY created_at', [itemId]);
    return rows.map(toLink);
  },

  async findLink(id: string): Promise<VaultLink | null> {
    const { rows } = await pool.query<LinkRow>('SELECT * FROM vault_item_links WHERE id = $1', [id]);
    return rows[0] ? toLink(rows[0]) : null;
  },

  /** Crée le lien ; null si un lien identique existe déjà. */
  async insertLink(itemId: string, projectId: string, scope: VaultLinkScope, userId: string | null, linkedBy: string | null): Promise<VaultLink | null> {
    const { rows } = await pool.query<LinkRow>(
      `INSERT INTO vault_item_links (item_id, project_id, scope, user_id, linked_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING *`,
      [itemId, projectId, scope, userId, linkedBy],
    );
    return rows[0] ? toLink(rows[0]) : null;
  },

  async deleteLink(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM vault_item_links WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  /** Retire les liens personnels d'une personne sur un élément (partage retiré) ; renvoie les liens retirés. */
  async deletePersonalLinks(itemId: string, userId: string): Promise<VaultLink[]> {
    const { rows } = await pool.query<LinkRow>(`DELETE FROM vault_item_links WHERE item_id = $1 AND scope = 'personal' AND user_id = $2 RETURNING *`, [itemId, userId]);
    return rows.map(toLink);
  },

  // ---- Journal ----------------------------------------------------------------------------------

  async addAudit(e: Omit<VaultAuditEvent, 'id' | 'createdAt'>): Promise<void> {
    await pool.query(
      `INSERT INTO vault_audit_events (item_id, item_name, item_kind, action, actor_user_id, session_id, project_id, ok, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.itemId, e.itemName, e.itemKind, e.action, e.actorUserId, e.sessionId, e.projectId, e.ok, e.detail],
    );
  },

  async listAudit(itemId: string, limit: number, before?: string | null): Promise<VaultAuditEvent[]> {
    const params: unknown[] = [itemId, Math.min(Math.max(limit, 1), 200)];
    const beforeSql = before ? `AND id < $${params.push(before)}` : '';
    const { rows } = await pool.query<AuditRow>(`SELECT * FROM vault_audit_events WHERE item_id = $1 ${beforeSql} ORDER BY id DESC LIMIT $2`, params);
    return rows.map(toAudit);
  },

  async pruneAudit(days: number): Promise<number> {
    const { rowCount } = await pool.query(`DELETE FROM vault_audit_events WHERE created_at < now() - ($1 || ' days')::interval`, [String(days)]);
    return rowCount ?? 0;
  },
};
