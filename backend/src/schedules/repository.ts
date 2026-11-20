import { pool } from '../db/pool.js';
import { toJson } from '../db/json.js';
import type { ScheduleArchivePolicy, ScheduleRun, ScheduleRunStatus, ScheduleRunTrigger, SessionSchedule } from './types.js';

interface Row {
  id: string;
  project_id: string;
  owner_id: string | null;
  requested_by_id: string | null;
  provider: string | null;
  config: Record<string, unknown> | null;
  name: string | null;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  end_after_run: boolean;
  archive_policy: ScheduleArchivePolicy | null;
  archive_after_minutes: number | null;
  allowed_tools: string[] | null;
  max_run_usd: string | number | null;
  monthly_budget_usd: string | number | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_result: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RunRow {
  id: string;
  schedule_id: string;
  run_session_id: string | null;
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
  id: r.id,
  projectId: r.project_id,
  ownerId: r.owner_id ?? null,
  requestedById: r.requested_by_id ?? null,
  provider: r.provider || 'claude',
  config: r.config ?? {},
  name: r.name ?? null,
  cron: r.cron,
  timezone: r.timezone,
  prompt: r.prompt,
  enabled: r.enabled,
  endAfterRun: r.end_after_run,
  archivePolicy: r.archive_policy ?? 'previous_on_run',
  archiveAfterMinutes: r.archive_after_minutes ?? null,
  allowedTools: r.allowed_tools ?? [],
  maxRunUsd: r.max_run_usd == null ? null : Number(r.max_run_usd),
  monthlyBudgetUsd: r.monthly_budget_usd == null ? null : Number(r.monthly_budget_usd),
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastResult: r.last_result,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRun = (r: RunRow): ScheduleRun => ({
  id: r.id,
  scheduleId: r.schedule_id,
  runSessionId: r.run_session_id ?? null,
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

/** Colonnes d'une planification (sans `session_id`, colonne d'avant gardée pour la version précédente). */
const COLS = `sc.id, sc.project_id, sc.owner_id, sc.requested_by_id, sc.provider, sc.config, sc.name, sc.cron, sc.timezone, sc.prompt,
  sc.enabled, sc.end_after_run, sc.archive_policy, sc.archive_after_minutes, sc.allowed_tools, sc.max_run_usd, sc.monthly_budget_usd, sc.next_run_at, sc.last_run_at,
  sc.last_result, sc.created_at, sc.updated_at`;
const RETURNING = COLS.replace(/sc\./g, '');

/** Valeurs enregistrables d'une planification ; undefined : inchangé (à la création : défaut). */
export interface ScheduleValues {
  name?: string | null;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  endAfterRun: boolean;
  nextRunAt: Date | null;
  allowedTools?: string[];
  archive?: { policy: ScheduleArchivePolicy; afterMinutes: number | null };
  config?: Record<string, unknown>;
  /** Plafonds de coût en USD : undefined inchangé, null retiré. */
  maxRunUsd?: number | null;
  monthlyBudgetUsd?: number | null;
  /** Nouveau propriétaire des exécutions (personne ou agent) et sa personne demandeuse ; absent : inchangés. */
  owner?: { ownerId: string; requestedById: string | null };
}

export const scheduleRepository = {
  async findById(id: string): Promise<SessionSchedule | null> {
    const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM session_schedules sc WHERE sc.id = $1`, [id]);
    return rows[0] ? toSchedule(rows[0]) : null;
  },

  async findByIds(ids: string[]): Promise<Map<string, SessionSchedule>> {
    if (!ids.length) return new Map();
    const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM session_schedules sc WHERE sc.id = ANY($1::uuid[])`, [ids]);
    return new Map(rows.map((r) => [r.id, toSchedule(r)]));
  },

  /** Planification qui a lancé chacune de ces sessions (sessions d'exécution) : chargeur groupé des listes de sessions. */
  async findByRunSessions(sessionIds: string[]): Promise<Map<string, SessionSchedule>> {
    if (!sessionIds.length) return new Map();
    const { rows } = await pool.query<Row & { run_session_id: string }>(
      `SELECT DISTINCT ON (r.run_session_id) r.run_session_id, ${COLS}
       FROM session_schedule_runs r JOIN session_schedules sc ON sc.id = r.schedule_id
       WHERE r.run_session_id = ANY($1::uuid[])
       ORDER BY r.run_session_id, r.started_at DESC`,
      [sessionIds],
    );
    return new Map(rows.map((r) => [r.run_session_id, toSchedule(r)]));
  },

  /** Planification d'avant dont `sessionId` était la session (actions d'agent enregistrées avant la refonte). */
  async findByLegacySession(sessionId: string): Promise<SessionSchedule | null> {
    const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM session_schedules sc WHERE sc.session_id = $1`, [sessionId]);
    return rows[0] ? toSchedule(rows[0]) : null;
  },

  /** Planifications de ces projets, les prochaines échéances d'abord. */
  async listForProjects(projectIds: string[]): Promise<SessionSchedule[]> {
    if (!projectIds.length) return [];
    const { rows } = await pool.query<Row>(
      `SELECT ${COLS} FROM session_schedules sc WHERE sc.project_id = ANY($1::uuid[])
       ORDER BY sc.enabled DESC, sc.next_run_at NULLS LAST, sc.created_at`,
      [projectIds],
    );
    return rows.map(toSchedule);
  },

  async create(values: ScheduleValues & { projectId: string; ownerId: string | null; requestedById: string | null; provider: string }): Promise<SessionSchedule> {
    const { rows } = await pool.query<Row>(
      `INSERT INTO session_schedules (project_id, owner_id, requested_by_id, provider, config, name, cron, timezone, prompt, enabled, end_after_run,
         next_run_at, allowed_tools, archive_policy, archive_after_minutes, max_run_usd, monthly_budget_usd)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::text[], '{}'), COALESCE($14, 'previous_on_run'), $15, $16, $17)
       RETURNING ${RETURNING}`,
      [
        values.projectId,
        values.ownerId,
        values.requestedById,
        values.provider,
        toJson(values.config ?? {}),
        values.name ?? null,
        values.cron,
        values.timezone,
        values.prompt,
        values.enabled,
        values.endAfterRun,
        values.nextRunAt,
        values.allowedTools ?? null,
        values.archive?.policy ?? null,
        values.archive?.afterMinutes ?? null,
        values.maxRunUsd ?? null,
        values.monthlyBudgetUsd ?? null,
      ],
    );
    return toSchedule(rows[0]);
  },

  /** Met à jour une planification. `name`, `allowedTools`, `archive` ou `config` undefined : inchangés. */
  async update(id: string, values: ScheduleValues): Promise<SessionSchedule | null> {
    const { rows } = await pool.query<Row>(
      `UPDATE session_schedules SET
         cron = $2, timezone = $3, prompt = $4, enabled = $5, end_after_run = $6, next_run_at = $7,
         name = CASE WHEN $9 THEN $8 ELSE name END,
         allowed_tools = COALESCE($10::text[], allowed_tools),
         archive_policy = COALESCE($11, archive_policy),
         archive_after_minutes = CASE WHEN $11 IS NULL THEN archive_after_minutes ELSE $12 END,
         config = COALESCE($13::jsonb, config),
         max_run_usd = CASE WHEN $14 THEN $15::numeric ELSE max_run_usd END,
         monthly_budget_usd = CASE WHEN $16 THEN $17::numeric ELSE monthly_budget_usd END,
         owner_id = COALESCE($18::uuid, owner_id),
         requested_by_id = CASE WHEN $18::uuid IS NULL THEN requested_by_id ELSE $19::uuid END,
         updated_at = now()
       WHERE id = $1 RETURNING ${RETURNING}`,
      [
        id,
        values.cron,
        values.timezone,
        values.prompt,
        values.enabled,
        values.endAfterRun,
        values.nextRunAt,
        values.name ?? null,
        values.name !== undefined,
        values.allowedTools ?? null,
        values.archive?.policy ?? null,
        values.archive?.afterMinutes ?? null,
        values.config === undefined ? null : toJson(values.config),
        values.maxRunUsd !== undefined,
        values.maxRunUsd ?? null,
        values.monthlyBudgetUsd !== undefined,
        values.monthlyBudgetUsd ?? null,
        values.owner?.ownerId ?? null,
        values.owner?.requestedById ?? null,
      ],
    );
    return rows[0] ? toSchedule(rows[0]) : null;
  },

  /** Met en pause ou réactive : l'échéance est recalculée par l'appelant (null en pause). */
  async setEnabled(id: string, enabled: boolean, nextRunAt: Date | null): Promise<SessionSchedule | null> {
    const { rows } = await pool.query<Row>(`UPDATE session_schedules SET enabled = $2, next_run_at = $3, updated_at = now() WHERE id = $1 RETURNING ${RETURNING}`, [id, enabled, nextRunAt]);
    return rows[0] ? toSchedule(rows[0]) : null;
  },

  /** Supprime la planification et son historique (les sessions d'exécution restent). */
  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM session_schedules WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  async listEnabled(): Promise<SessionSchedule[]> {
    const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM session_schedules sc WHERE sc.enabled ORDER BY sc.next_run_at`);
    return rows.map(toSchedule);
  },

  /** Planifications activées dont l'échéance est passée. */
  async listDue(now: Date): Promise<SessionSchedule[]> {
    const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM session_schedules sc WHERE sc.enabled AND sc.next_run_at IS NOT NULL AND sc.next_run_at <= $1 ORDER BY sc.next_run_at`, [now]);
    return rows.map(toSchedule);
  },

  /**
   * Réserve une exécution : avance l'échéance seulement si elle est encore celle que l'on a lue.
   * Renvoie null si une autre instance du serveur l'a déjà prise.
   */
  async claim(id: string, expectedNextRunAt: Date, nextRunAt: Date | null, now: Date): Promise<SessionSchedule | null> {
    const { rows } = await pool.query<Row>(
      `UPDATE session_schedules SET next_run_at = $3, last_run_at = $4, last_result = 'En cours', updated_at = now()
       WHERE id = $1 AND enabled AND next_run_at = $2 RETURNING ${RETURNING}`,
      [id, expectedNextRunAt, nextRunAt, now],
    );
    return rows[0] ? toSchedule(rows[0]) : null;
  },

  async setNextRunAt(id: string, nextRunAt: Date | null): Promise<void> {
    await pool.query('UPDATE session_schedules SET next_run_at = $2, updated_at = now() WHERE id = $1', [id, nextRunAt]);
  },

  async setResult(id: string, result: string): Promise<void> {
    await pool.query('UPDATE session_schedules SET last_result = $2, updated_at = now() WHERE id = $1', [id, result.slice(0, 500)]);
  },

  async markRun(id: string, at: Date): Promise<void> {
    await pool.query('UPDATE session_schedules SET last_run_at = $2, updated_at = now() WHERE id = $1', [id, at]);
  },

  /**
   * Sessions qui ne portaient que les réglages d'une planification d'avant (jamais lancées, jamais session d'une
   * exécution) et encore actives : rangées au démarrage, elles n'ont plus de raison d'être.
   */
  async legacyHolderSessions(): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT s.id FROM session_schedules sc JOIN sessions s ON s.id = sc.session_id
       WHERE s.archived_at IS NULL AND s.status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM session_schedule_runs r WHERE r.run_session_id = s.id)
       LIMIT 200`,
    );
    return rows.map((r) => r.id);
  },

  // ---- Historique des exécutions ----------------------------------------------------------------------

  /** Ouvre une exécution ; une issue terminale (ignorée, manquée) est enregistrée d'emblée, close. */
  async createRun(values: { scheduleId: string; trigger: ScheduleRunTrigger; triggeredBy?: string | null; status: ScheduleRunStatus; scheduledFor?: Date | null; message?: string | null; startEventId?: string | null }): Promise<ScheduleRun> {
    const closed = values.status !== 'running';
    const { rows } = await pool.query<RunRow>(
      `INSERT INTO session_schedule_runs (schedule_id, trigger, triggered_by, status, scheduled_for, message, start_event_id, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() END) RETURNING *`,
      [values.scheduleId, values.trigger, values.triggeredBy ?? null, values.status, values.scheduledFor ?? null, values.message?.slice(0, 1000) ?? null, values.startEventId ?? null, closed],
    );
    return toRun(rows[0]);
  },

  async setRunStartEvent(runId: string, eventId: string): Promise<void> {
    await pool.query('UPDATE session_schedule_runs SET start_event_id = $2 WHERE id = $1', [runId, eventId]);
  },

  async setRunSession(runId: string, runSessionId: string): Promise<void> {
    await pool.query('UPDATE session_schedule_runs SET run_session_id = $2 WHERE id = $1', [runId, runSessionId]);
  },

  /** Une exécution de cette planification est-elle encore en cours (sur n'importe quelle instance) ? */
  async hasRunning(scheduleId: string): Promise<boolean> {
    const { rows } = await pool.query(`SELECT 1 FROM session_schedule_runs WHERE schedule_id = $1 AND status = 'running' LIMIT 1`, [scheduleId]);
    return rows.length > 0;
  },

  /** Sessions d'exécutions closes de cette planification encore actives (hors `exceptId`) : archivées au lancement d'une nouvelle. */
  async activeRunSessions(scheduleId: string, exceptId: string | null = null): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT DISTINCT s.id FROM session_schedule_runs r JOIN sessions s ON s.id = r.run_session_id
       WHERE r.schedule_id = $1 AND r.status <> 'running' AND s.archived_at IS NULL AND s.id <> $2::uuid
       LIMIT 50`,
      [scheduleId, exceptId ?? '00000000-0000-0000-0000-000000000000'],
    );
    return rows.map((r) => r.id);
  },

  /** Sessions d'exécution encore actives (non archivées) de cette planification, les plus récentes d'abord. */
  async liveRunSessions(scheduleId: string, limit = 20): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT s.id FROM sessions s
       WHERE s.archived_at IS NULL AND s.id IN (SELECT r.run_session_id FROM session_schedule_runs r WHERE r.schedule_id = $1 AND r.run_session_id IS NOT NULL)
       ORDER BY s.created_at DESC LIMIT $2`,
      [scheduleId, limit],
    );
    return rows.map((r) => r.id);
  },

  /** Sessions d'exécutions closes depuis plus que le délai de leur planification (`after_delay`), encore actives. */
  async runSessionsPastDelay(now: Date): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT DISTINCT s.id FROM session_schedule_runs r
       JOIN session_schedules sc ON sc.id = r.schedule_id
       JOIN sessions s ON s.id = r.run_session_id
       WHERE sc.archive_policy = 'after_delay' AND sc.archive_after_minutes IS NOT NULL
         AND r.status <> 'running' AND r.finished_at IS NOT NULL
         AND r.finished_at <= $1::timestamptz - make_interval(mins => sc.archive_after_minutes)
         AND s.archived_at IS NULL
       LIMIT 50`,
      [now],
    );
    return rows.map((r) => r.id);
  },

  /**
   * Sessions d'exécutions « dès la fin » closes sans avoir été archivées parce qu'elles n'avaient pas fini (demande
   * sans réponse : `blocked`, toujours au travail : `timeout`), et qui ont fini depuis : session au repos ou terminée,
   * plus de demande en attente, rien dans le transcript depuis `quietMinutes` (une personne qui y travaille la garde).
   */
  async settledUnfinishedRunSessions(now: Date, quietMinutes: number): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT DISTINCT s.id FROM session_schedule_runs r
       JOIN session_schedules sc ON sc.id = r.schedule_id
       JOIN sessions s ON s.id = r.run_session_id
       WHERE sc.archive_policy = 'on_finish' AND r.status IN ('blocked', 'timeout')
         AND s.archived_at IS NULL
         AND (s.status::text NOT IN ('running', 'queued') OR s.activity::text = 'idle')
         AND NOT EXISTS (SELECT 1 FROM requests q WHERE q.session_id = s.id AND q.status = 'pending')
         AND NOT EXISTS (SELECT 1 FROM session_events e WHERE e.session_id = s.id AND e.created_at > $1::timestamptz - make_interval(mins => $2::int))
       LIMIT 50`,
      [now, quietMinutes],
    );
    return rows.map((r) => r.id);
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

  async listRuns(scheduleId: string, limit = 20): Promise<ScheduleRun[]> {
    const { rows } = await pool.query<RunRow>('SELECT * FROM session_schedule_runs WHERE schedule_id = $1 ORDER BY started_at DESC LIMIT $2', [scheduleId, Math.min(Math.max(limit, 1), 200)]);
    return rows.map(toRun);
  },

  /** Les `perSchedule` dernières exécutions de chaque planification (chargeur groupé de la liste des planifications). */
  async listRecentRuns(scheduleIds: string[], perSchedule: number): Promise<Map<string, ScheduleRun[]>> {
    const out = new Map<string, ScheduleRun[]>();
    if (!scheduleIds.length) return out;
    const { rows } = await pool.query<RunRow>(
      `SELECT r.* FROM unnest($1::uuid[]) AS ids(id)
       CROSS JOIN LATERAL (SELECT * FROM session_schedule_runs WHERE schedule_id = ids.id ORDER BY started_at DESC LIMIT $2) r`,
      [scheduleIds, perSchedule],
    );
    for (const r of rows) {
      const list = out.get(r.schedule_id) ?? [];
      list.push(toRun(r));
      out.set(r.schedule_id, list);
    }
    for (const list of out.values()) list.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return out;
  },

  /**
   * Outils pré-autorisés de la planification si une de ses exécutions est en cours dans cette session, sinon null :
   * ils ne valent que pendant un tour lancé par la planification (l'exécution est ouverte avant l'envoi de
   * l'instruction et close après la fin du tour).
   */
  async activeRunRules(sessionId: string): Promise<string[] | null> {
    const { rows } = await pool.query<{ allowed_tools: string[] | null }>(
      `SELECT sc.allowed_tools FROM session_schedule_runs r JOIN session_schedules sc ON sc.id = r.schedule_id
       WHERE r.status = 'running' AND r.run_session_id = $1 LIMIT 1`,
      [sessionId],
    );
    return rows[0] ? (rows[0].allowed_tools ?? []) : null;
  },

  /** Résultats de tour (`claude.result`) d'une exécution : après son jalon de début, jusqu'à sa fin (ou maintenant). */
  async runResultEvents(sessionId: string, startEventId: string, until: Date | null): Promise<{ type: string; payload: Record<string, unknown> }[]> {
    const { rows } = await pool.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM session_events
       WHERE session_id = $1 AND id > $2 AND type = 'claude.result' AND ($3::timestamptz IS NULL OR created_at <= $3)
       ORDER BY id LIMIT 200`,
      [sessionId, startEventId, until],
    );
    return rows;
  },

  /** Demandes d'autorisation créées pendant une exécution. */
  async runPermissionRequests(sessionId: string, from: Date, until: Date | null): Promise<{ type: string; status: string; payload: Record<string, unknown>; response: Record<string, unknown> | null }[]> {
    const { rows } = await pool.query<{ type: string; status: string; payload: Record<string, unknown>; response: Record<string, unknown> | null }>(
      `SELECT type, status, payload, response FROM requests
       WHERE session_id = $1 AND type = 'permission' AND created_at >= $2 AND ($3::timestamptz IS NULL OR created_at <= $3)
       ORDER BY created_at LIMIT 200`,
      [sessionId, from, until],
    );
    return rows;
  },

  /** Exécutions encore « en cours » ouvertes avant `before` (reprise de celles dont le suivi a été perdu). */
  /** Consommation comptée (USD, tours `billable` comme le budget des projets) des sessions d'exécution de la planification depuis `since`. */
  async spentSince(scheduleId: string, since: Date): Promise<number> {
    const { rows } = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(l.cost_usd), 0) AS total FROM usage_ledger l
       WHERE l.billable AND l.recorded_at >= $2 AND l.session_id IN (SELECT r.run_session_id FROM session_schedule_runs r WHERE r.schedule_id = $1 AND r.run_session_id IS NOT NULL)`,
      [scheduleId, since],
    );
    return Number(rows[0].total);
  },

  /** Consommation (USD) d'une session (coût d'une exécution : chaque exécution a sa propre session). */
  async sessionSpent(sessionId: string): Promise<number> {
    const { rows } = await pool.query<{ total: string }>('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_ledger WHERE session_id = $1 AND billable', [sessionId]);
    return Number(rows[0].total);
  },

  async listRunningBefore(before: Date): Promise<ScheduleRun[]> {
    const { rows } = await pool.query<RunRow>(`SELECT * FROM session_schedule_runs WHERE status = 'running' AND started_at < $1 ORDER BY started_at LIMIT 50`, [before]);
    return rows.map(toRun);
  },
};
