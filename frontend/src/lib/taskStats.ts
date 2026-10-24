import type { Task, TaskPriority, TaskStatus } from '../graphql/operations';

/**
 * Vue « pilotage » des tâches : indicateurs de gestion de projet calculés côté client à partir des tâches chargées
 * (toutes, terminées et annulées comprises). Tout est pur, avec un instant `now` explicite, pour être testable ; le
 * rendu est dans components/TaskDashboard.tsx.
 *
 * Méthode : flux (créées / terminées par semaine), avancement cumulé (périmètre et terminées jour par jour), délai de
 * traitement (création → terminée), et prévision probabiliste de fin du reste à faire par simulation de Monte-Carlo sur
 * le débit hebdomadaire observé (méthode courante en Kanban : on rejoue des semaines tirées au hasard dans l'historique
 * jusqu'à épuiser le reste à faire, et on lit les percentiles des durées obtenues).
 */

export const DAY = 86_400_000;

/** Sous-ensemble d'une tâche utilisé par les calculs (les tests construisent ces objets à la main). */
export type StatTask = Pick<Task, 'id' | 'title' | 'status' | 'priority' | 'createdAt' | 'updatedAt' | 'completedAt' | 'dueDate' | 'statusTag' | 'assignee'> & {
  session?: Task['session'] | null;
};

export const PERIOD_CHOICES: { weeks: number; label: string }[] = [
  { weeks: 4, label: '4 sem.' },
  { weeks: 8, label: '8 sem.' },
  { weeks: 13, label: '13 sem.' },
  { weeks: 26, label: '26 sem.' },
];

const PRIORITY_RANK: Record<TaskPriority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
export const PRIORITY_ORDER: TaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];

export const isOpen = (t: { status: TaskStatus }) => t.status === 'TODO' || t.status === 'IN_PROGRESS';

/** Minuit (heure locale) du jour de `d`. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Lundi 00:00 (heure locale) de la semaine de `d`. */
export function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  const shift = (day.getDay() + 6) % 7; // lundi = 0
  return addDays(day, -shift);
}

/** `n` jours plus tard, en calendrier local (insensible aux changements d'heure). */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

/** Début de la période de `weeks` semaines qui se termine par la semaine en cours. */
export function periodStart(now: Date, weeks: number): Date {
  return addDays(startOfWeek(now), -7 * (weeks - 1));
}

export function ageDays(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY));
}

/** Date d'annulation approchée : la dernière mise à jour (le statut n'a pas d'historique propre). */
const cancelledAt = (t: StatTask): number | null => (t.status === 'CANCELLED' ? new Date(t.updatedAt).getTime() : null);
const completedAt = (t: StatTask): number | null => (t.status === 'DONE' && t.completedAt ? new Date(t.completedAt).getTime() : null);

// ---- Flux hebdomadaire ----------------------------------------------------------------------------

export interface WeekBucket {
  start: Date;
  /** « 13 oct. » : lundi de la semaine. */
  label: string;
  created: number;
  done: number;
  cancelled: number;
}

export const shortDate = (d: Date) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

/** Créées, terminées et annulées par semaine sur les `weeks` dernières semaines (la semaine en cours en dernier). */
export function weeklyBuckets(tasks: StatTask[], now: Date, weeks: number): WeekBucket[] {
  const start = periodStart(now, weeks);
  const buckets: WeekBucket[] = [];
  for (let i = 0; i < weeks; i++) {
    const s = addDays(start, 7 * i);
    buckets.push({ start: s, label: shortDate(s), created: 0, done: 0, cancelled: 0 });
  }
  const index = (ms: number | null): number => {
    if (ms == null || ms < start.getTime() || ms > now.getTime()) return -1;
    for (let i = buckets.length - 1; i >= 0; i--) if (ms >= buckets[i].start.getTime()) return i;
    return -1;
  };
  for (const t of tasks) {
    const c = index(new Date(t.createdAt).getTime());
    if (c >= 0) buckets[c].created++;
    const d = index(completedAt(t));
    if (d >= 0) buckets[d].done++;
    const x = index(cancelledAt(t));
    if (x >= 0) buckets[x].cancelled++;
  }
  return buckets;
}

// ---- Avancement cumulé (burn-up) ------------------------------------------------------------------

export interface BurnupPoint {
  date: Date;
  /** Tâches existantes à la fin du jour (créées, non annulées). */
  scope: number;
  /** Tâches terminées à la fin du jour. */
  done: number;
}

/** Un point par jour, du début de la période à aujourd'hui (valeurs à la fin de chaque jour, à l'instant `now` pour le dernier). */
export function burnup(tasks: StatTask[], now: Date, weeks: number): BurnupPoint[] {
  const start = periodStart(now, weeks);
  const points: BurnupPoint[] = [];
  for (let day = start; day.getTime() <= now.getTime(); day = addDays(day, 1)) {
    const cutoff = Math.min(addDays(day, 1).getTime(), now.getTime());
    let scope = 0;
    let done = 0;
    for (const t of tasks) {
      if (new Date(t.createdAt).getTime() > cutoff) continue;
      const x = cancelledAt(t);
      if (x != null && x <= cutoff) continue;
      scope++;
      const d = completedAt(t);
      if (d != null && d <= cutoff) done++;
    }
    points.push({ date: day, scope, done });
  }
  return points;
}

// ---- Délai de traitement --------------------------------------------------------------------------

/** Percentile `p` (0..1) d'une liste triée, par interpolation linéaire. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Délais création → terminée (en jours, décimaux) des tâches terminées pendant la période, triés. */
export function leadTimes(tasks: StatTask[], now: Date, weeks: number): number[] {
  const start = periodStart(now, weeks).getTime();
  const out: number[] = [];
  for (const t of tasks) {
    const d = completedAt(t);
    if (d == null || d < start || d > now.getTime()) continue;
    out.push(Math.max(0, (d - new Date(t.createdAt).getTime()) / DAY));
  }
  return out.sort((a, b) => a - b);
}

// ---- Prévision ------------------------------------------------------------------------------------

/** Générateur pseudo-aléatoire déterministe (mulberry32) : la prévision ne change pas d'un rendu à l'autre. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Forecast {
  /** Semaines pour terminer le reste à faire, dans 50 % puis 85 % des simulations. */
  p50: number;
  p85: number;
}

const MAX_WEEKS = 520;

/**
 * Monte-Carlo : rejoue des semaines tirées au hasard (avec remise) dans `weeklyDone` jusqu'à écouler `remaining`.
 * `null` quand aucune semaine n'a produit de tâche terminée (aucune base pour prévoir) ou quand même la moitié des
 * simulations dépassent dix ans.
 */
export function forecast(remaining: number, weeklyDone: number[], runs = 2000, rng: () => number = seededRandom(42)): Forecast | null {
  if (remaining <= 0) return { p50: 0, p85: 0 };
  if (weeklyDone.length === 0 || weeklyDone.every((n) => n <= 0)) return null;
  const results: number[] = [];
  for (let r = 0; r < runs; r++) {
    let left = remaining;
    let weeks = 0;
    while (left > 0 && weeks < MAX_WEEKS) {
      left -= weeklyDone[Math.floor(rng() * weeklyDone.length)];
      weeks++;
    }
    results.push(weeks);
  }
  results.sort((a, b) => a - b);
  const p50 = Math.ceil(percentile(results, 0.5));
  if (p50 >= MAX_WEEKS) return null;
  return { p50, p85: Math.min(MAX_WEEKS, Math.ceil(percentile(results, 0.85))) };
}

// ---- Répartitions ---------------------------------------------------------------------------------

export interface Breakdown {
  key: string;
  label: string;
  todo: number;
  inProgress: number;
}

export function byPriority(open: StatTask[]): Breakdown[] {
  const labels: Record<TaskPriority, string> = { URGENT: 'Urgente', HIGH: 'Haute', MEDIUM: 'Moyenne', LOW: 'Basse' };
  return PRIORITY_ORDER.map((p) => ({
    key: p,
    label: labels[p],
    todo: open.filter((t) => t.priority === p && t.status === 'TODO').length,
    inProgress: open.filter((t) => t.priority === p && t.status === 'IN_PROGRESS').length,
  }));
}

/** Tâches ouvertes par responsable, les plus chargés d'abord ; au-delà de `max`, le reste est regroupé dans « Autres ». */
export function byAssignee(open: StatTask[], max = 7): Breakdown[] {
  const m = new Map<string, Breakdown>();
  for (const t of open) {
    const key = t.assignee ? (t.assignee.email ?? t.assignee.name ?? '').toLowerCase() : '';
    const label = t.assignee ? (t.assignee.name ?? t.assignee.email ?? '') : 'Sans responsable';
    const b = m.get(key) ?? { key: key || '∅', label, todo: 0, inProgress: 0 };
    if (t.status === 'TODO') b.todo++;
    else b.inProgress++;
    m.set(key, b);
  }
  const all = [...m.values()].sort((a, b) => b.todo + b.inProgress - (a.todo + a.inProgress) || a.label.localeCompare(b.label));
  const none = all.find((b) => b.key === '∅');
  const named = all.filter((b) => b.key !== '∅');
  const head = named.slice(0, max);
  const tail = named.slice(max);
  const out = [...head];
  if (tail.length) out.push({ key: 'others', label: `Autres (${tail.length})`, todo: tail.reduce((s, b) => s + b.todo, 0), inProgress: tail.reduce((s, b) => s + b.inProgress, 0) });
  if (none) out.push(none);
  return out;
}

// ---- Listes ---------------------------------------------------------------------------------------

export const isBlocked = (t: { statusTag: string | null }) => /bloqu|blocked/i.test(t.statusTag ?? '');
export const isOverdueAt = (t: { dueDate: string | null; status: TaskStatus }, now: Date) => Boolean(t.dueDate) && isOpen(t) && t.dueDate! < isoDay(now);
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** À faire, par priorité puis échéance la plus proche puis ancienneté : ce qu'il faudrait lancer ensuite. */
export function nextTasks<T extends StatTask>(tasks: T[], n = 8): T[] {
  return tasks
    .filter((t) => t.status === 'TODO')
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.createdAt.localeCompare(b.createdAt))
    .slice(0, n);
}

export type WatchReason = 'overdue' | 'due_soon' | 'blocked' | 'stale' | 'urgent_idle';

export interface WatchItem<T> {
  task: T;
  reason: WatchReason;
  detail: string;
}

export const WATCH_LABELS: Record<WatchReason, string> = {
  overdue: 'En retard',
  due_soon: 'Échéance proche',
  blocked: 'Bloquée',
  stale: 'Sans activité',
  urgent_idle: 'Urgente, personne dessus',
};

/** Session d'agent en cours sur la tâche (elle travaille ou attend). */
export const hasRunningSession = (t: StatTask) => t.session?.status === 'RUNNING';

/**
 * Tâches qui méritent un regard, la raison la plus grave d'abord : en retard, bloquées, urgentes sans session,
 * en cours sans activité depuis `staleDays` jours (sans session d'agent qui tourne), échéance sous `soonDays` jours.
 */
export function watchlist<T extends StatTask>(tasks: T[], now: Date, { soonDays = 7, staleDays = 3 } = {}): WatchItem<T>[] {
  const out: WatchItem<T>[] = [];
  const soon = isoDay(addDays(now, soonDays));
  const today = isoDay(now);
  for (const t of tasks) {
    if (!isOpen(t)) continue;
    if (isOverdueAt(t, now)) out.push({ task: t, reason: 'overdue', detail: `depuis ${ageDays(`${t.dueDate}T00:00:00`, startOfDay(now))} j` });
    else if (isBlocked(t)) out.push({ task: t, reason: 'blocked', detail: t.statusTag ?? '' });
    else if (t.priority === 'URGENT' && t.status === 'TODO' && !hasRunningSession(t)) out.push({ task: t, reason: 'urgent_idle', detail: `créée il y a ${ageDays(t.createdAt, now)} j` });
    else if (t.status === 'IN_PROGRESS' && !hasRunningSession(t) && ageDays(t.updatedAt, now) >= staleDays) out.push({ task: t, reason: 'stale', detail: `dernière mise à jour il y a ${ageDays(t.updatedAt, now)} j` });
    else if (t.dueDate && t.dueDate >= today && t.dueDate <= soon) out.push({ task: t, reason: 'due_soon', detail: t.dueDate === today ? "aujourd'hui" : `le ${new Date(`${t.dueDate}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}` });
  }
  const rank: Record<WatchReason, number> = { overdue: 0, blocked: 1, urgent_idle: 2, stale: 3, due_soon: 4 };
  return out.sort((a, b) => rank[a.reason] - rank[b.reason] || PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority]);
}

// ---- Synthèse -------------------------------------------------------------------------------------

export interface DashboardStats {
  weeks: number;
  open: number;
  todo: number;
  inProgress: number;
  /** Ouvertes urgentes ou hautes. */
  important: number;
  /** En cours : avec une session qui travaille, qui attend, sans session active, bloquées. */
  working: number;
  waiting: number;
  unattended: number;
  blocked: number;
  overdue: number;
  dueSoon: number;
  /** Terminées sur les 7 derniers jours et les 7 jours précédents. */
  doneWeek: number;
  donePrevWeek: number;
  /** Créées et terminées sur la période (hors semaine en cours pour le débit moyen, voir `throughput`). */
  createdPeriod: number;
  donePeriod: number;
  cancelledPeriod: number;
  /** Débit : moyenne, mini et maxi hebdomadaires sur les semaines révolues de la période (la semaine en cours, incomplète, est exclue). */
  throughput: { mean: number; min: number; max: number; weeks: number };
  leadTime: { median: number; p85: number; count: number };
  forecast: Forecast | null;
  forecastDates: { p50: Date; p85: Date } | null;
  buckets: WeekBucket[];
  burnup: BurnupPoint[];
}

export function dashboardStats(tasks: StatTask[], now: Date, weeks: number): DashboardStats {
  const open = tasks.filter(isOpen);
  const inProgress = open.filter((t) => t.status === 'IN_PROGRESS');
  const buckets = weeklyBuckets(tasks, now, weeks);
  const past = buckets.slice(0, -1);
  const doneSamples = (past.length ? past : buckets).map((b) => b.done);
  const mean = doneSamples.reduce((s, n) => s + n, 0) / Math.max(1, doneSamples.length);
  const lt = leadTimes(tasks, now, weeks);
  const fc = forecast(open.length, doneSamples);
  const weekAgo = addDays(now, -7).getTime();
  const twoWeeksAgo = addDays(now, -14).getTime();
  const doneBetween = (a: number, b: number) => tasks.filter((t) => {
    const d = completedAt(t);
    return d != null && d > a && d <= b;
  }).length;
  const soon = isoDay(addDays(now, 7));
  const today = isoDay(now);
  return {
    weeks,
    open: open.length,
    todo: open.length - inProgress.length,
    inProgress: inProgress.length,
    important: open.filter((t) => t.priority === 'URGENT' || t.priority === 'HIGH').length,
    working: inProgress.filter((t) => t.session?.status === 'RUNNING' && t.session.activity === 'BUSY').length,
    waiting: inProgress.filter((t) => t.session?.status === 'RUNNING' && t.session.activity !== 'BUSY').length,
    unattended: inProgress.filter((t) => !hasRunningSession(t)).length,
    blocked: open.filter(isBlocked).length,
    overdue: open.filter((t) => isOverdueAt(t, now)).length,
    dueSoon: open.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= soon).length,
    doneWeek: doneBetween(weekAgo, now.getTime()),
    donePrevWeek: doneBetween(twoWeeksAgo, weekAgo),
    createdPeriod: buckets.reduce((s, b) => s + b.created, 0),
    donePeriod: buckets.reduce((s, b) => s + b.done, 0),
    cancelledPeriod: buckets.reduce((s, b) => s + b.cancelled, 0),
    throughput: { mean, min: Math.min(...doneSamples), max: Math.max(...doneSamples), weeks: doneSamples.length },
    leadTime: { median: percentile(lt, 0.5), p85: percentile(lt, 0.85), count: lt.length },
    forecast: fc,
    forecastDates: fc ? { p50: addDays(now, 7 * fc.p50), p85: addDays(now, 7 * fc.p85) } : null,
    buckets,
    burnup: burnup(tasks, now, weeks),
  };
}

/** « 3 j », « 12 h », « < 1 h » pour un délai en jours décimaux. */
export function formatDays(days: number): string {
  if (days >= 2) return `${Math.round(days)} j`;
  if (days >= 1) return `${days.toFixed(1).replace('.0', '')} j`;
  const h = Math.round(days * 24);
  return h >= 1 ? `${h} h` : '< 1 h';
}
