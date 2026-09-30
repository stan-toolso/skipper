import { pool } from '../db/pool.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import type { Project } from '../projects/types.js';
import { requestService } from '../requests/service.js';
import type { HumanRequest } from '../requests/types.js';
import { sessionService } from '../sessions/service.js';
import type { Session } from '../sessions/types.js';
import { settingsService } from '../settings/service.js';
import { currentMonthStart } from '../settings/usage.js';
import { taskService } from '../tasks/service.js';
import type { Task } from '../tasks/types.js';

/**
 * Tableau de bord d'accueil : ce qui attend l'utilisateur, ce qui tourne, et ce que ça coûte, sur
 * l'ensemble de ses projets. Tout est calculé en quelques requêtes agrégées (pas de N+1) et
 * restreint aux projets passés en paramètre (ceux dont l'utilisateur est membre).
 */

export interface DashboardCounts {
  pendingRequests: number;
  busySessions: number;
  idleSessions: number;
  /** Sessions en erreur ou interrompues au cours des dernières 24 h. */
  failedSessions24h: number;
  /** Sessions terminées (tous statuts finaux) au cours des dernières 24 h. */
  endedSessions24h: number;
  todoTasks: number;
  inProgressTasks: number;
  /** Tâches ouvertes dont l'échéance est dépassée. */
  overdueTasks: number;
  /** Tâches terminées au cours des 7 derniers jours. */
  doneTasks7d: number;
  unreadNotifications: number;
}

export interface DashboardUsageDay {
  /** AAAA-MM-JJ (jour du serveur). */
  day: string;
  usd: number;
}

export interface DashboardUsage {
  monthStart: Date;
  /** Consommation du mois sur les projets de l'utilisateur. */
  monthUsd: number;
  /** Consommation du mois toutes sessions confondues (celle que le plafond compare). */
  globalMonthUsd: number;
  monthlyBudgetUsd: number | null;
  todayUsd: number;
  last7DaysUsd: number;
  previous7DaysUsd: number;
  byDay: DashboardUsageDay[];
  topSessions: { sessionId: string | null; sessionName: string | null; projectName: string | null; usd: number }[];
}

export interface DashboardProject {
  project: Project;
  busySessions: number;
  idleSessions: number;
  pendingRequests: number;
  todoTasks: number;
  inProgressTasks: number;
  overdueTasks: number;
  monthUsd: number;
  lastActivityAt: Date | null;
}

export interface Dashboard {
  generatedAt: Date;
  counts: DashboardCounts;
  usage: DashboardUsage;
  projects: DashboardProject[];
  pendingRequests: HumanRequest[];
  runningSessions: Session[];
  recentSessions: Session[];
  attentionTasks: Task[];
}

const DAYS_OF_HISTORY = 30;

const n = (v: string | number | null | undefined) => Number(v ?? 0);

interface ProjectStatsRow {
  project_id: string;
  busy: string;
  idle: string;
  pending_requests: string;
  todo: string;
  in_progress: string;
  overdue: string;
  month_usd: string;
  last_activity_at: Date | null;
}

async function projectStats(projectIds: string[], monthStart: Date): Promise<Map<string, ProjectStatsRow>> {
  if (!projectIds.length) return new Map();
  const { rows } = await pool.query<ProjectStatsRow>(
    `WITH ids AS (SELECT unnest($1::uuid[]) AS project_id),
     s AS (
       SELECT project_id,
              count(*) FILTER (WHERE status = 'running' AND activity = 'busy') AS busy,
              count(*) FILTER (WHERE status = 'running' AND activity IS DISTINCT FROM 'busy') AS idle,
              max(updated_at) AS last_session_at
         FROM sessions WHERE project_id = ANY($1::uuid[]) GROUP BY project_id),
     r AS (
       SELECT s.project_id, count(*) AS pending_requests
         FROM requests q JOIN sessions s ON s.id = q.session_id
        WHERE q.status = 'pending' AND s.project_id = ANY($1::uuid[]) GROUP BY s.project_id),
     t AS (
       SELECT project_id,
              count(*) FILTER (WHERE status = 'todo') AS todo,
              count(*) FILTER (WHERE status = 'in_progress') AS in_progress,
              count(*) FILTER (WHERE status IN ('todo', 'in_progress') AND due_date IS NOT NULL AND due_date < current_date) AS overdue,
              max(updated_at) AS last_task_at
         FROM tasks WHERE project_id = ANY($1::uuid[]) GROUP BY project_id),
     u AS (
       SELECT project_id, sum(cost_usd) AS month_usd
         FROM usage_ledger WHERE project_id = ANY($1::uuid[]) AND recorded_at >= $2 GROUP BY project_id)
     SELECT ids.project_id,
            COALESCE(s.busy, 0)::text AS busy, COALESCE(s.idle, 0)::text AS idle,
            COALESCE(r.pending_requests, 0)::text AS pending_requests,
            COALESCE(t.todo, 0)::text AS todo, COALESCE(t.in_progress, 0)::text AS in_progress, COALESCE(t.overdue, 0)::text AS overdue,
            COALESCE(u.month_usd, 0)::text AS month_usd,
            GREATEST(s.last_session_at, t.last_task_at) AS last_activity_at
       FROM ids
       LEFT JOIN s ON s.project_id = ids.project_id
       LEFT JOIN r ON r.project_id = ids.project_id
       LEFT JOIN t ON t.project_id = ids.project_id
       LEFT JOIN u ON u.project_id = ids.project_id`,
    [projectIds, monthStart],
  );
  return new Map(rows.map((r) => [r.project_id, r]));
}

async function globalCounts(projectIds: string[]): Promise<Omit<DashboardCounts, 'unreadNotifications' | 'pendingRequests' | 'busySessions' | 'idleSessions' | 'todoTasks' | 'inProgressTasks' | 'overdueTasks'>> {
  if (!projectIds.length) return { failedSessions24h: 0, endedSessions24h: 0, doneTasks7d: 0 };
  const { rows } = await pool.query<{ failed: string; ended: string; done: string }>(
    `SELECT
       (SELECT count(*) FROM sessions WHERE project_id = ANY($1::uuid[]) AND status = 'failed' AND ended_at >= now() - interval '24 hours')::text AS failed,
       (SELECT count(*) FROM sessions WHERE project_id = ANY($1::uuid[]) AND status IN ('completed', 'failed', 'stopped', 'interrupted') AND ended_at >= now() - interval '24 hours')::text AS ended,
       (SELECT count(*) FROM tasks WHERE project_id = ANY($1::uuid[]) AND status = 'done' AND completed_at >= now() - interval '7 days')::text AS done`,
    [projectIds],
  );
  return { failedSessions24h: n(rows[0].failed), endedSessions24h: n(rows[0].ended), doneTasks7d: n(rows[0].done) };
}

async function usage(projectIds: string[], monthStart: Date): Promise<DashboardUsage> {
  const monthlyBudgetUsd = settingsService.claude.monthlyBudgetUsd;
  const { rows: global } = await pool.query<{ total: string }>('SELECT COALESCE(sum(cost_usd), 0)::text AS total FROM usage_ledger WHERE recorded_at >= $1', [monthStart]);
  const globalMonthUsd = n(global[0].total);
  if (!projectIds.length) {
    return { monthStart, monthUsd: 0, globalMonthUsd, monthlyBudgetUsd, todayUsd: 0, last7DaysUsd: 0, previous7DaysUsd: 0, byDay: [], topSessions: [] };
  }
  const [totals, byDay, top] = await Promise.all([
    pool.query<{ month: string; today: string; last7: string; prev7: string }>(
      `SELECT COALESCE(sum(cost_usd) FILTER (WHERE recorded_at >= $2), 0)::text AS month,
              COALESCE(sum(cost_usd) FILTER (WHERE recorded_at >= date_trunc('day', now())), 0)::text AS today,
              COALESCE(sum(cost_usd) FILTER (WHERE recorded_at >= date_trunc('day', now()) - interval '6 days'), 0)::text AS last7,
              COALESCE(sum(cost_usd) FILTER (WHERE recorded_at >= date_trunc('day', now()) - interval '13 days' AND recorded_at < date_trunc('day', now()) - interval '6 days'), 0)::text AS prev7
         FROM usage_ledger WHERE project_id = ANY($1::uuid[])`,
      [projectIds, monthStart],
    ),
    pool.query<{ day: string; usd: string }>(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(sum(l.cost_usd), 0)::text AS usd
         FROM generate_series(date_trunc('day', now()) - ($2::int - 1) * interval '1 day', date_trunc('day', now()), interval '1 day') AS d(day)
         LEFT JOIN usage_ledger l ON l.project_id = ANY($1::uuid[]) AND l.recorded_at >= d.day AND l.recorded_at < d.day + interval '1 day'
        GROUP BY d.day ORDER BY d.day`,
      [projectIds, DAYS_OF_HISTORY],
    ),
    pool.query<{ session_id: string | null; session_name: string | null; project_name: string | null; usd: string }>(
      `SELECT l.session_id, s.name AS session_name, p.name AS project_name, sum(l.cost_usd)::text AS usd
         FROM usage_ledger l
         LEFT JOIN sessions s ON s.id = l.session_id
         LEFT JOIN projects p ON p.id = COALESCE(l.project_id, s.project_id)
        WHERE l.project_id = ANY($1::uuid[]) AND l.recorded_at >= $2
        GROUP BY l.session_id, s.name, p.name ORDER BY sum(l.cost_usd) DESC LIMIT 5`,
      [projectIds, monthStart],
    ),
  ]);
  const t = totals.rows[0];
  return {
    monthStart,
    monthUsd: n(t.month),
    globalMonthUsd,
    monthlyBudgetUsd,
    todayUsd: n(t.today),
    last7DaysUsd: n(t.last7),
    previous7DaysUsd: n(t.prev7),
    byDay: byDay.rows.map((r) => ({ day: r.day, usd: n(r.usd) })),
    topSessions: top.rows.map((r) => ({ sessionId: r.session_id, sessionName: r.session_name, projectName: r.project_name, usd: n(r.usd) })),
  };
}

/** Tâches ouvertes qui méritent un coup d'œil : en retard, urgentes ou hautes (les plus pressantes d'abord). */
async function attentionTasks(projectIds: string[]): Promise<Task[]> {
  if (!projectIds.length) return [];
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM tasks
      WHERE project_id = ANY($1::uuid[]) AND status IN ('todo', 'in_progress')
        AND (priority IN ('urgent', 'high') OR (due_date IS NOT NULL AND due_date <= current_date + 2))
      ORDER BY (due_date IS NOT NULL AND due_date < current_date) DESC,
               CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               due_date NULLS LAST, created_at
      LIMIT 8`,
    [projectIds],
  );
  const tasks = await Promise.all(rows.map((r) => taskService.get(r.id).catch(() => null)));
  return tasks.filter((t): t is Task => t !== null);
}

/** Sessions arrivées à un état final récemment, les plus récentes d'abord. */
async function recentSessions(projectIds: string[]): Promise<Session[]> {
  if (!projectIds.length) return [];
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM sessions
      WHERE project_id = ANY($1::uuid[]) AND status IN ('completed', 'failed', 'stopped', 'interrupted')
      ORDER BY COALESCE(ended_at, updated_at) DESC LIMIT 8`,
    [projectIds],
  );
  const sessions = await Promise.all(rows.map((r) => sessionService.get(r.id)));
  return sessions.filter((s): s is Session => s !== null);
}

export const dashboardService = {
  async build(userId: string, projectIds: string[], now = new Date()): Promise<Dashboard> {
    const monthStart = currentMonthStart(now);
    const [projects, stats, extra, usageData, pending, running, recent, tasks, unread] = await Promise.all([
      projectService.listForUser(userId),
      projectStats(projectIds, monthStart),
      globalCounts(projectIds),
      usage(projectIds, monthStart),
      requestService.list({ projectIds, status: 'pending', limit: 20 }),
      projectIds.length ? sessionService.list({ projectIds, status: 'running', limit: 50 }) : Promise.resolve([]),
      recentSessions(projectIds),
      attentionTasks(projectIds),
      notificationService.countUnread(projectIds),
    ]);

    const perProject: DashboardProject[] = projects.map((project) => {
      const s = stats.get(project.id);
      return {
        project,
        busySessions: n(s?.busy),
        idleSessions: n(s?.idle),
        pendingRequests: n(s?.pending_requests),
        todoTasks: n(s?.todo),
        inProgressTasks: n(s?.in_progress),
        overdueTasks: n(s?.overdue),
        monthUsd: n(s?.month_usd),
        lastActivityAt: s?.last_activity_at ?? null,
      };
    });
    const sum = (key: keyof Omit<DashboardProject, 'project' | 'lastActivityAt'>) => perProject.reduce((a, p) => a + p[key], 0);

    return {
      generatedAt: now,
      counts: {
        pendingRequests: sum('pendingRequests'),
        busySessions: sum('busySessions'),
        idleSessions: sum('idleSessions'),
        todoTasks: sum('todoTasks'),
        inProgressTasks: sum('inProgressTasks'),
        overdueTasks: sum('overdueTasks'),
        unreadNotifications: unread,
        ...extra,
      },
      usage: usageData,
      // Les projets qui réclament quelque chose d'abord, puis les plus actifs.
      projects: perProject.sort(
        (a, b) =>
          b.pendingRequests - a.pendingRequests ||
          b.busySessions + b.idleSessions - (a.busySessions + a.idleSessions) ||
          (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0) ||
          a.project.name.localeCompare(b.project.name),
      ),
      pendingRequests: pending,
      runningSessions: running,
      recentSessions: recent,
      attentionTasks: tasks,
    };
  },
};
