import { pool } from '../db/pool.js';
import type { Connection, ConnectionKind, ConnectionSettings } from './types.js';

interface Row {
  id: string;
  project_id: string;
  name: string;
  kind: ConnectionKind;
  description: string;
  settings: ConnectionSettings;
  secrets: Record<string, string>;
  public_key: string | null;
  host_key: string | null;
  host_key_seen_at: Date | null;
  read_only: boolean;
  require_approval: boolean;
  command_allowlist: string[];
  last_test_at: Date | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const toConnection = (r: Row): Connection => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  kind: r.kind,
  description: r.description,
  settings: r.settings,
  secrets: r.secrets ?? {},
  publicKey: r.public_key,
  hostKey: r.host_key,
  hostKeySeenAt: r.host_key_seen_at,
  readOnly: r.read_only,
  requireApproval: r.require_approval,
  commandAllowlist: Array.isArray(r.command_allowlist) ? r.command_allowlist : [],
  lastTestAt: r.last_test_at,
  lastTestOk: r.last_test_ok,
  lastTestError: r.last_test_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface ConnectionRecordInput {
  name: string;
  kind: ConnectionKind;
  description: string;
  settings: ConnectionSettings;
  secrets: Record<string, string>;
  publicKey: string | null;
  readOnly: boolean;
  requireApproval: boolean;
  commandAllowlist: string[];
}

export const connectionRepository = {
  async create(projectId: string, input: ConnectionRecordInput): Promise<Connection> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO connections (project_id, name, kind, description, settings, secrets, public_key, read_only, require_approval, command_allowlist)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10::jsonb) RETURNING *`,
      [
        projectId,
        input.name,
        input.kind,
        input.description,
        JSON.stringify(input.settings),
        JSON.stringify(input.secrets),
        input.publicKey,
        input.readOnly,
        input.requireApproval,
        JSON.stringify(input.commandAllowlist),
      ],
    );
    return toConnection(rows[0]);
  },

  async update(id: string, patch: Partial<ConnectionRecordInput> & { hostKey?: string | null; hostKeySeenAt?: Date | null }): Promise<Connection> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown, cast = '') => sets.push(`${column} = $${params.push(value)}${cast}`);
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.settings !== undefined) set('settings', JSON.stringify(patch.settings), '::jsonb');
    if (patch.secrets !== undefined) set('secrets', JSON.stringify(patch.secrets), '::jsonb');
    if (patch.publicKey !== undefined) set('public_key', patch.publicKey);
    if (patch.hostKey !== undefined) set('host_key', patch.hostKey);
    if (patch.hostKeySeenAt !== undefined) set('host_key_seen_at', patch.hostKeySeenAt);
    if (patch.readOnly !== undefined) set('read_only', patch.readOnly);
    if (patch.requireApproval !== undefined) set('require_approval', patch.requireApproval);
    if (patch.commandAllowlist !== undefined) set('command_allowlist', JSON.stringify(patch.commandAllowlist), '::jsonb');
    sets.push('updated_at = now()');
    const { rows } = await pool.query<Row>(`UPDATE connections SET ${sets.join(', ')} WHERE id = $${params.push(id)} RETURNING *`, params);
    return toConnection(rows[0]);
  },

  async recordTest(id: string, ok: boolean, error: string | null): Promise<void> {
    await pool.query('UPDATE connections SET last_test_at = now(), last_test_ok = $2, last_test_error = $3 WHERE id = $1', [id, ok, error]);
  },

  async findById(id: string): Promise<Connection | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM connections WHERE id = $1', [id]);
    return rows[0] ? toConnection(rows[0]) : null;
  },

  async findByName(projectId: string, name: string): Promise<Connection | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM connections WHERE project_id = $1 AND name = $2', [projectId, name]);
    return rows[0] ? toConnection(rows[0]) : null;
  },

  async listByProject(projectId: string): Promise<Connection[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM connections WHERE project_id = $1 ORDER BY name ASC', [projectId]);
    return rows.map(toConnection);
  },

  /** Connexions qui traversent la connexion SSH donnée (tunnel). */
  async listDependents(viaConnectionId: string): Promise<Connection[]> {
    const { rows } = await pool.query<Row>(`SELECT * FROM connections WHERE settings->>'viaConnectionId' = $1 ORDER BY name ASC`, [viaConnectionId]);
    return rows.map(toConnection);
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM connections WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },
};
