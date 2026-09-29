import { pool } from '../db/pool.js';
import type { PermissionRule } from './types.js';

interface Row {
  id: string;
  project_id: string;
  tool_name: string;
  rule_content: string | null;
  created_by_session_id: string | null;
  created_at: Date;
}

const toRule = (r: Row): PermissionRule => ({
  id: r.id,
  projectId: r.project_id,
  toolName: r.tool_name,
  ruleContent: r.rule_content,
  createdBySessionId: r.created_by_session_id,
  createdAt: r.created_at,
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

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM project_permission_rules WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },
};
