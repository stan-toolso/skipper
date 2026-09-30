import { pool } from '../db/pool.js';
import type { SessionSchedule } from './types.js';

interface Row {
  session_id: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  end_after_run: boolean;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_result: string | null;
  created_at: Date;
  updated_at: Date;
}

const toSchedule = (r: Row): SessionSchedule => ({
  sessionId: r.session_id,
  cron: r.cron,
  timezone: r.timezone,
  prompt: r.prompt,
  enabled: r.enabled,
  endAfterRun: r.end_after_run,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastResult: r.last_result,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const scheduleRepository = {
  async findBySession(sessionId: string): Promise<SessionSchedule | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM session_schedules WHERE session_id = $1', [sessionId]);
    return rows[0] ? toSchedule(rows[0]) : null;
  },

  /** Crée ou remplace la planification d'une session. */
  async upsert(sessionId: string, values: { cron: string; timezone: string; prompt: string; enabled: boolean; endAfterRun: boolean; nextRunAt: Date | null }): Promise<SessionSchedule> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO session_schedules (session_id, cron, timezone, prompt, enabled, end_after_run, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (session_id) DO UPDATE SET
         cron = EXCLUDED.cron, timezone = EXCLUDED.timezone, prompt = EXCLUDED.prompt, enabled = EXCLUDED.enabled,
         end_after_run = EXCLUDED.end_after_run, next_run_at = EXCLUDED.next_run_at, updated_at = now()
       RETURNING *`,
      [sessionId, values.cron, values.timezone, values.prompt, values.enabled, values.endAfterRun, values.nextRunAt],
    );
    return toSchedule(rows[0]);
  },

  async delete(sessionId: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM session_schedules WHERE session_id = $1', [sessionId]);
    return (rowCount ?? 0) > 0;
  },

  async listEnabled(): Promise<SessionSchedule[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM session_schedules WHERE enabled ORDER BY next_run_at');
    return rows.map(toSchedule);
  },

  /** Planifications activées dont l'échéance est passée. */
  async listDue(now: Date): Promise<SessionSchedule[]> {
    const { rows } = await pool.query<Row>('SELECT * FROM session_schedules WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at', [now]);
    return rows.map(toSchedule);
  },

  /**
   * Réserve une exécution : avance l'échéance seulement si elle est encore celle que l'on a lue.
   * Renvoie null si une autre instance du serveur l'a déjà prise.
   */
  async claim(sessionId: string, expectedNextRunAt: Date, nextRunAt: Date | null, now: Date): Promise<SessionSchedule | null> {
    const { rows } = await pool.query<Row>(
      `UPDATE session_schedules SET next_run_at = $3, last_run_at = $4, last_result = 'En cours', updated_at = now()
       WHERE session_id = $1 AND enabled AND next_run_at = $2 RETURNING *`,
      [sessionId, expectedNextRunAt, nextRunAt, now],
    );
    return rows[0] ? toSchedule(rows[0]) : null;
  },

  async setNextRunAt(sessionId: string, nextRunAt: Date | null): Promise<void> {
    await pool.query('UPDATE session_schedules SET next_run_at = $2, updated_at = now() WHERE session_id = $1', [sessionId, nextRunAt]);
  },

  async setResult(sessionId: string, result: string): Promise<void> {
    await pool.query('UPDATE session_schedules SET last_result = $2, updated_at = now() WHERE session_id = $1', [sessionId, result.slice(0, 500)]);
  },
};
