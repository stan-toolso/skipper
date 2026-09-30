import { pool } from '../db/pool.js';
import type { PermissionRule } from './types.js';

interface Row {
  id: string;
  project_id: string;
  tool_name: string;
  rule_content: string | null;
  created_by_session_id: string | null;
  created_at: Date;
  last_used_at: Date | null;
  use_count: number;
  usage_tracked_since: Date;
}

const toRule = (r: Row): PermissionRule => ({
  id: r.id,
  projectId: r.project_id,
  toolName: r.tool_name,
  ruleContent: r.rule_content,
  createdBySessionId: r.created_by_session_id,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count,
  usageTrackedSince: r.usage_tracked_since,
});

export const permissionRuleRepository = {
  async list(projectId: string): Promise<PermissionRule[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM project_permission_rules WHERE project_id = $1 ORDER BY tool_name ASC, rule_content ASC NULLS FIRST', [projectId]);
    return rows.map(toRule);
  },

  async findById(id: string): Promise<PermissionRule | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM project_permission_rules WHERE id = $1', [id]);
    return rows[0] ? toRule(rows[0]) : null;
  },

  /** Insère la règle si elle n'existe pas déjà ; renvoie la règle (existante ou créée). */
  async upsert(projectId: string, toolName: string, ruleContent: string | null, sessionId: string | null): Promise<PermissionRule> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO project_permission_rules (project_id, tool_name, rule_content, created_by_session_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, tool_name, COALESCE(rule_content, '')) DO UPDATE SET tool_name = EXCLUDED.tool_name RETURNING *`,
      [projectId, toolName, ruleContent, sessionId],
    );
    return toRule(rows[0]);
  },

  async update(id: string, toolName: string, ruleContent: string | null): Promise<PermissionRule | null> {
    const { rows } = await pool.query<Row>('UPDATE project_permission_rules SET tool_name = $2, rule_content = $3 WHERE id = $1 RETURNING *', [id, toolName, ruleContent]);
    return rows[0] ? toRule(rows[0]) : null;
  },

  /** Compte une utilisation des règles indiquées (un appel d'outil qu'elles ont autorisé). */
  async markUsed(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await pool.query('UPDATE project_permission_rules SET last_used_at = now(), use_count = use_count + 1 WHERE id = ANY($1::uuid[])', [ids]);
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM project_permission_rules WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  /** Retire plusieurs règles du projet ; renvoie les identifiants effectivement retirés. */
  async deleteMany(projectId: string, ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const { rows } = await pool.query<{ id: string }>('DELETE FROM project_permission_rules WHERE project_id = $1 AND id = ANY($2::uuid[]) RETURNING id', [projectId, ids]);
    return rows.map((r) => r.id);
  },
};
