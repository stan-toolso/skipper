import { pool } from '../db/pool.js';
import type { UsageSummary } from './types.js';

/** Début du mois calendaire courant (heure du serveur). */
export function currentMonthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/**
 * Relevé de consommation : le SDK rapporte un coût cumulé par session (`total_cost_usd`) ; on
 * enregistre à chaque tour le delta par rapport au dernier total connu, avec sa ventilation par
 * modèle, pour pouvoir sommer par mois, par modèle et par session.
 */
export const usageService = {
  /** Dernier total connu pour la session (survit aux redémarrages). */
  async knownTotal(sessionId: string): Promise<number> {
    const { rows } = await pool.query<{ cost_usd: string }>('SELECT cost_usd FROM sessions WHERE id = $1', [sessionId]);
    return Number(rows[0]?.cost_usd ?? 0);
  },

  /**
   * Enregistre le nouveau total cumulé d'une session. `modelTotals` = coût cumulé par modèle
   * (`modelUsage` du SDK), utilisé pour ventiler le delta ; à défaut le delta est attribué à `fallbackModel`.
   * Renvoie le delta enregistré (0 si rien à enregistrer).
   */
  async recordTotal(
    sessionId: string,
    projectId: string,
    total: number,
    modelTotals: Record<string, number>,
    previousModelTotals: Record<string, number>,
    fallbackModel: string,
  ): Promise<number> {
    const known = await this.knownTotal(sessionId);
    if (!(total > known)) {
      // Total inférieur (ex. /clear) : on réaligne sans compter de delta négatif.
      if (total < known) await pool.query('UPDATE sessions SET cost_usd = $2 WHERE id = $1', [sessionId, total]);
      return 0;
    }
    const delta = total - known;
    const models: Record<string, number> = {};
    for (const [model, cost] of Object.entries(modelTotals)) {
      const d = cost - (previousModelTotals[model] ?? 0);
      if (d > 0) models[model] = Number(d.toFixed(6));
    }
    if (!Object.keys(models).length) models[fallbackModel] = Number(delta.toFixed(6));
    // Session reprise : les cumuls par modèle repartent du transcript alors que le delta, lui, est
    // relatif au dernier total connu. On ramène la ventilation à l'échelle du delta.
    const attributed = Object.values(models).reduce((a, b) => a + b, 0);
    if (attributed > delta * 1.01 && attributed > 0) {
      for (const k of Object.keys(models)) models[k] = Number(((models[k] * delta) / attributed).toFixed(6));
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE sessions SET cost_usd = $2 WHERE id = $1', [sessionId, total]);
      await client.query('INSERT INTO usage_ledger (session_id, project_id, models, cost_usd) VALUES ($1, $2, $3::jsonb, $4)', [sessionId, projectId, JSON.stringify(models), delta.toFixed(6)]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return delta;
  },

  async monthTotal(now = new Date()): Promise<number> {
    const { rows } = await pool.query<{ total: string }>('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_ledger WHERE recorded_at >= $1', [currentMonthStart(now)]);
    return Number(rows[0].total);
  },

  async summary(now = new Date()): Promise<UsageSummary> {
    const monthStart = currentMonthStart(now);
    const [month, total, byModel, bySession] = await Promise.all([
      this.monthTotal(now),
      pool.query<{ total: string }>('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_ledger'),
      pool.query<{ model: string; usd: string }>(
        `SELECT m.key AS model, SUM((m.value)::numeric) AS usd
           FROM usage_ledger l, jsonb_each_text(l.models) AS m
          WHERE l.recorded_at >= $1
          GROUP BY m.key ORDER BY usd DESC`,
        [monthStart],
      ),
      pool.query<{ session_id: string | null; session_name: string | null; project_name: string | null; usd: string }>(
        `SELECT l.session_id, s.name AS session_name, p.name AS project_name, SUM(l.cost_usd) AS usd
           FROM usage_ledger l
           LEFT JOIN sessions s ON s.id = l.session_id
           LEFT JOIN projects p ON p.id = COALESCE(l.project_id, s.project_id)
          WHERE l.recorded_at >= $1
          GROUP BY l.session_id, s.name, p.name ORDER BY usd DESC LIMIT 10`,
        [monthStart],
      ),
    ]);
    return {
      monthStart,
      monthUsd: month,
      totalUsd: Number(total.rows[0].total),
      byModel: byModel.rows.map((r) => ({ model: r.model, usd: Number(r.usd) })),
      bySession: bySession.rows.map((r) => ({ sessionId: r.session_id, sessionName: r.session_name, projectName: r.project_name, usd: Number(r.usd) })),
    };
  },
};
