import type { Task, TaskPriority } from '../graphql/operations';
import { fold, PRIORITY_LABELS, todayIso } from './taskTable';

/**
 * Liste des tâches rangée par ce qui est attendu : chaque tâche tombe dans un « couloir » (à traiter, en cours, en
 * attente, à faire, bloquées, terminées, annulées) d'après son statut et ses signaux (agent arrêté, PR à fusionner,
 * échéance dépassée, réveil passé, dépendances). Tout est pur et testé (taskGroups.test.ts) ; le rendu est dans
 * components/TaskGrid.tsx.
 */

export type TaskLane = 'attention' | 'active' | 'waiting' | 'ready' | 'blocked' | 'done' | 'cancelled';

export interface LaneInfo {
  key: TaskLane;
  label: string;
  hint: string;
  /** Couleur de la pastille (variable du thème). */
  tone: string;
}

export const LANES: LaneInfo[] = [
  { key: 'attention', label: 'À traiter', hint: 'Une décision ou une action de votre part est attendue', tone: 'var(--cc-red)' },
  { key: 'active', label: 'En cours', hint: 'Un agent ou une personne y travaille', tone: 'var(--cc-accent)' },
  { key: 'waiting', label: 'En attente', hint: "L'agent attend quelque chose (réveil daté, retour, livraison)", tone: 'var(--cc-yellow)' },
  { key: 'ready', label: 'À faire', hint: 'Prêtes à être lancées, de la plus prioritaire à la moins', tone: 'var(--cc-fg)' },
  { key: 'blocked', label: 'Bloquées', hint: "Attendent qu'une autre tâche soit terminée", tone: 'var(--cc-dim)' },
  { key: 'done', label: 'Terminées', hint: 'Fermées récemment', tone: 'var(--cc-green)' },
  { key: 'cancelled', label: 'Annulées', hint: '', tone: 'var(--cc-dimmer)' },
];
export const LANE_BY_KEY = Object.fromEntries(LANES.map((l) => [l.key, l])) as Record<TaskLane, LaneInfo>;

export interface Placement {
  lane: TaskLane;
  /** Pourquoi la tâche est « à traiter » (court, affiché devant le titre). */
  reason: string | null;
}

const PRIORITY_RANK: Record<TaskPriority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** Range une tâche. `now` sert à l'échéance et au réveil. */
export function placeTask(t: Task, now = new Date()): Placement {
  if (t.status === 'CANCELLED') return { lane: 'cancelled', reason: null };
  if (t.status === 'DONE') return { lane: 'done', reason: null };
  const overdue = Boolean(t.dueDate) && t.dueDate! < todayIso(now);
  if (t.status === 'IN_PROGRESS') {
    if (t.stalledSince) return { lane: 'attention', reason: 'agent arrêté' };
    if (t.pullRequests?.some((pr) => pr.stage === 'TO_MERGE')) return { lane: 'attention', reason: 'PR à fusionner' };
    if (overdue) return { lane: 'attention', reason: 'en retard' };
    if (t.waitingSince) {
      if (t.wakeAt && new Date(t.wakeAt).getTime() <= now.getTime()) return { lane: 'attention', reason: 'réveil passé' };
      return { lane: 'waiting', reason: null };
    }
    return { lane: 'active', reason: null };
  }
  // À faire.
  if (t.blockedBy.length > 0) return { lane: 'blocked', reason: null };
  if (overdue) return { lane: 'attention', reason: 'en retard' };
  if (t.priority === 'URGENT') return { lane: 'attention', reason: 'urgente, pas commencée' };
  return { lane: 'ready', reason: null };
}

/** Ordre « par pertinence » dans un couloir, quand la personne n'a pas choisi de tri. */
export function autoCompare(lane: TaskLane): (a: Task, b: Task) => number {
  const time = (s: string | null | undefined) => (s ? new Date(s).getTime() : 0);
  const byPriority = (a: Task, b: Task) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  const byDue = (a: Task, b: Task) => (a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : (a.dueDate ?? '9999') > (b.dueDate ?? '9999') ? 1 : 0;
  switch (lane) {
    case 'done':
      return (a, b) => time(b.completedAt ?? b.updatedAt) - time(a.completedAt ?? a.updatedAt);
    case 'cancelled':
      return (a, b) => time(b.cancelledAt ?? b.updatedAt) - time(a.cancelledAt ?? a.updatedAt);
    case 'ready':
    case 'blocked':
      // Le plus important d'abord, puis l'échéance, puis la plus ancienne (premier arrivé, premier servi).
      return (a, b) => byPriority(a, b) || byDue(a, b) || time(a.createdAt) - time(b.createdAt);
    default:
      // À traiter, en cours, en attente : le plus important, puis ce qui a bougé le plus récemment.
      return (a, b) => byPriority(a, b) || byDue(a, b) || time(b.updatedAt) - time(a.updatedAt);
  }
}

export type GroupBy = 'lane' | 'priority' | 'project' | 'assignee' | 'none';
export const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'lane', label: 'Ce qui est attendu' },
  { value: 'priority', label: 'Priorité' },
  { value: 'project', label: 'Projet' },
  { value: 'assignee', label: 'Responsable' },
  { value: 'none', label: 'Sans groupe' },
];

export interface TaskGroup {
  key: string;
  label: string;
  hint?: string;
  tone?: string;
  /** Couloir quand le groupement est par couloir (sert aux pliages par défaut). */
  lane?: TaskLane;
  tasks: Task[];
}

/**
 * Groupe des tâches déjà filtrées. `sort` : comparateur choisi par la personne (en-tête de colonne), sinon l'ordre
 * par pertinence du couloir de chaque tâche. Les groupes vides ne sont pas rendus.
 */
export function groupTasks(tasks: Task[], groupBy: GroupBy, placements: Map<string, Placement>, sort: ((list: Task[]) => Task[]) | null): TaskGroup[] {
  const order = (list: Task[], lane?: TaskLane): Task[] => {
    if (sort) return sort(list);
    if (lane) return [...list].sort(autoCompare(lane));
    // Hors couloirs : chaque tâche à sa place dans l'ordre des couloirs, puis par pertinence.
    const rank = (t: Task) => LANES.findIndex((l) => l.key === placements.get(t.id)?.lane);
    return [...list].sort((a, b) => rank(a) - rank(b) || autoCompare(placements.get(a.id)?.lane ?? 'ready')(a, b));
  };
  if (groupBy === 'none') return tasks.length ? [{ key: 'all', label: 'Toutes', tasks: order(tasks) }] : [];
  if (groupBy === 'lane') {
    return LANES.map((l) => ({ key: l.key, label: l.label, hint: l.hint, tone: l.tone, lane: l.key, tasks: order(tasks.filter((t) => placements.get(t.id)?.lane === l.key), l.key) })).filter((g) => g.tasks.length > 0);
  }
  const buckets = new Map<string, { label: string; rank: string; tasks: Task[] }>();
  for (const t of tasks) {
    let key: string;
    let label: string;
    let rank: string;
    if (groupBy === 'priority') {
      key = t.priority;
      label = PRIORITY_LABELS[t.priority];
      rank = String(PRIORITY_RANK[t.priority]);
    } else if (groupBy === 'project') {
      key = t.project.id;
      label = t.project.name;
      rank = fold(t.project.name);
    } else {
      const who = t.assignee?.name ?? t.assignee?.email ?? null;
      key = who ? fold(t.assignee?.email ?? who) : '';
      label = who ?? 'Sans responsable';
      rank = who ? `0${fold(who)}` : '1';
    }
    const b = buckets.get(key) ?? { label, rank, tasks: [] };
    b.tasks.push(t);
    buckets.set(key, b);
  }
  return [...buckets.entries()].sort((a, b) => (a[1].rank < b[1].rank ? -1 : a[1].rank > b[1].rank ? 1 : 0)).map(([key, b]) => ({ key: `${groupBy}:${key}`, label: b.label, tasks: order(b.tasks) }));
}

/** Compte par couloir (bandeau de synthèse). */
export function laneCounts(tasks: Task[], placements: Map<string, Placement>): Record<TaskLane, number> {
  const counts = Object.fromEntries(LANES.map((l) => [l.key, 0])) as Record<TaskLane, number>;
  for (const t of tasks) {
    const lane = placements.get(t.id)?.lane;
    if (lane) counts[lane]++;
  }
  return counts;
}

/** Recherche libre : titre, description, étiquettes, responsable, projet, branche, numéro de PR. Tous les mots doivent se trouver. */
export function matchesSearch(t: Task, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(
    [
      t.title,
      t.summary ?? '',
      t.description,
      t.tags.join(' '),
      t.statusTag ?? '',
      t.assignee?.name ?? '',
      t.assignee?.email ?? '',
      t.project.name,
      t.worksession?.branch ?? t.branch ?? '',
      ...(t.pullRequests ?? []).map((pr) => (pr.number != null ? `#${pr.number}` : '')),
      t.id.slice(0, 8),
    ].join(' '),
  );
  return words.every((w) => hay.includes(w));
}

/** Nombre de jours de « terminées récemment » montrées dans la liste. */
export const RECENT_DAYS = 14;
