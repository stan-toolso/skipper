import { pool } from '../db/pool.js';
import type { ScheduleRun, ScheduleRunStatus, ScheduleRunTrigger, ScheduleWithSession, SessionSchedule } from './types.js';

interface Row {
  session_id: string;
  name: string | null;
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

interface RunRow {
  id: string;
  session_id: string;
  trigger: ScheduleRunTrigger;
  triggered_by: string | null;
  status: ScheduleRunStatus;
  scheduled_for: Date | null;
  started_at: Date;
  finished_at: Date | null;
  cost_usd: number | null;
  duration_ms: number | null;
  message: string | null;
  answer: string | null;
  start_event_id: string | null;
}

const toSchedule = (r: Row): SessionSchedule => ({
  sessionId: r.session_id,
  name: r.name ?? null,
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

const toRun = (r: RunRow): ScheduleRun => ({
  id: r.id,
  sessionId: r.session_id,
  trigger: r.trigger,
  triggeredBy: r.triggered_by,
  status: r.status,
  scheduledFor: r.scheduled_for,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  costUsd: r.cost_usd,
  durationMs: r.duration_ms,
  message: r.message,
  answer: r.answer ?? null,
  startEventId: r.start_event_id === null ? null : String(r.start_event_id),
});

export const scheduleRepository = {
  async findBySession(sessionId: string): Promise<SessionSchedule | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM session_schedules WHERE session_id = $1', [sessionId]);
    return rows[0] ? toSchedule(rows[0]) : null;
  },

  /** Planifications de plusieurs sessions (chargeur groupé des listes de sessions). */
  async findBySessions(sessionIds: string[]): Promise<Map<string, SessionSchedule>> {
    if (!sessionIds.length) return new Map();
    const { rows } = await pool.query<Row>('SELECT * FROM session_schedules WHERE session_id = ANY($1::uuid[])', [sessionIds]);
    return new Map(rows.map((r) => [r.session_id, toSchedule(r)]));
  },

  /** Planifications des sessions non archivées de ces projets, les prochaines échéances d'abord. */
  async listForProjects(projectIds: string[]): Promise<ScheduleWithSession[]> {
    if (!projectIds.length) return [];
    const { rows } = await pool.query<Row & { project_id: string }>(
      `SELECT sc.*, s.project_id FROM session_schedules sc JOIN sessions s ON s.id = sc.session_id
       WHERE s.project_id = ANY($1::uuid[]) AND s.archived_at IS NULL
       ORDER BY sc.enabled DESC, sc.next_run_at NULLS LAST, sc.created_at`,
      [projectIds],
    );
    return rows.map((r) => ({ ...toSchedule(r), projectId: r.project_id }));
  },

  /** Crée ou remplace la planification d'une session. `name` undefined : nom inchangé. */
  async upsert(sessionId: string, values: { name?: string | null; cron: string; timezone: string; prompt: string; enabled: boolean; endAfterRun: boolean; nextRunAt: Date | null }): Promise<SessionSchedule> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO session_schedules (session_id, cron, timezone, prompt, enabled, end_after_run, next_run_at, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (session_id) DO UPDATE SET
         cron = EXCLUDED.cron, timezone = EXCLUDED.timezone, prompt = EXCLUDED.prompt, enabled = EXCLUDED.enabled,
         end_after_run = EXCLUDED.end_after_run, next_run_at = EXCLUDED.next_run_at,
         name = CASE WHEN $9 THEN EXCLUDED.name ELSE session_schedules.name END, updated_at = now()
       RETURNING *`,
      [sessionId, values.cron, values.timezone, values.prompt, values.enabled, values.endAfterRun, values.nextRunAt, values.name ?? null, values.name !== undefined],
    );
    return toSchedule(rows[0]);
  },

  /** Met en pause ou réactive : l'échéance est recalculée par l'appelant (null en pause). */
  async setEnabled(sessionId: string, enabled: boolean, nextRunAt: Date | null): Promise<SessionSchedule | null> {
    const { rows } = await pool.query<Row>('UPDATE session_schedules SET enabled = $2, next_run_at = $3, updated_at = now() WHERE session_id = $1 RETURNING *', [sessionId, enabled, nextRunAt]);
    return rows[0] ? toSchedule(rows[0]) : null;
  },

  /** Retire la planification et son historique. */
  async delete(sessionId: string): Promise<boolean> {
    await pool.query('DELETE FROM session_schedule_runs WHERE session_id = $1', [sessionId]);
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

  async markRun(sessionId: string, at: Date): Promise<void> {
    await pool.query('UPDATE session_schedules SET last_run_at = $2, updated_at = now() WHERE session_id = $1', [sessionId, at]);
  },

  // ---- Historique des exécutions ----------------------------------------------------------------------

  /** Ouvre une exécution ; une issue terminale (ignorée, manquée) est enregistrée d'emblée, close. */
  async createRun(values: { sessionId: string; trigger: ScheduleRunTrigger; triggeredBy?: string | null; status: ScheduleRunStatus; scheduledFor?: Date | null; message?: string | null; startEventId?: string | null }): Promise<ScheduleRun> {
    const closed = values.status !== 'running';
    const { rows } = await pool.query<RunRow>(
      `INSERT INTO session_schedule_runs (session_id, trigger, triggered_by, status, scheduled_for, message, start_event_id, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() END) RETURNING *`,
      [values.sessionId, values.trigger, values.triggeredBy ?? null, values.status, values.scheduledFor ?? null, values.message?.slice(0, 1000) ?? null, values.startEventId ?? null, closed],
    );
    return toRun(rows[0]);
  },

  async setRunStartEvent(runId: string, eventId: string): Promise<void> {
    await pool.query('UPDATE session_schedule_runs SET start_event_id = $2 WHERE id = $1', [runId, eventId]);
  },

  /**
   * Clôt une exécution encore en cours. Renvoie null si elle était déjà close (une autre instance, ou la
   * reprise des exécutions orphelines, l'a fait) : seul celui qui clôt notifie.
   */
  async finishRun(runId: string, values: { status: ScheduleRunStatus; costUsd: number | null; durationMs: number | null; message: string | null; answer?: string | null }): Promise<ScheduleRun | null> {
    const { rows } = await pool.query<RunRow>(
      `UPDATE session_schedule_runs SET status = $2, cost_usd = $3, duration_ms = $4, message = $5, answer = $6, finished_at = now()
       WHERE id = $1 AND status = 'running' RETURNING *`,
      [runId, values.status, values.costUsd, values.durationMs, values.message?.slice(0, 1000) ?? null, values.answer?.slice(0, 4000) ?? null],
    );
    return rows[0] ? toRun(rows[0]) : null;
  },

  async listRuns(sessionId: string, limit = 20): Promise<ScheduleRun[]> {
    const { rows } = await pool.query<RunRow>('SELECT * FROM session_schedule_runs WHERE session_id = $1 ORDER BY started_at DESC LIMIT $2', [sessionId, Math.min(Math.max(limit, 1), 200)]);
    return rows.map(toRun);
  },

  /** Les `perSession` dernières exécutions de chaque session (chargeur groupé de la liste des planifications). */
  async listRecentRuns(sessionIds: string[], perSession: number): Promise<Map<string, ScheduleRun[]>> {
    const out = new Map<string, ScheduleRun[]>();
    if (!sessionIds.length) return out;
    const { rows } = await pool.query<RunRow>(
      `SELECT r.* FROM unnest($1::uuid[]) AS ids(id)
       CROSS JOIN LATERAL (SELECT * FROM session_schedule_runs WHERE session_id = ids.id ORDER BY started_at DESC LIMIT $2) r`,
      [sessionIds, perSession],
    );
    for (const r of rows) {
      const list = out.get(r.session_id) ?? [];
      list.push(toRun(r));
      out.set(r.session_id, list);
    }
    for (const list of out.values()) list.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return out;
  },

  /** Exécutions encore « en cours » ouvertes avant `before` (reprise de celles dont le suivi a été perdu). */
  async listRunningBefore(before: Date): Promise<ScheduleRun[]> {
    const { rows } = await pool.query<RunRow>(`SELECT * FROM session_schedule_runs WHERE status = 'running' AND started_at < $1 ORDER BY started_at LIMIT 50`, [before]);
    return rows.map(toRun);
  },
};
