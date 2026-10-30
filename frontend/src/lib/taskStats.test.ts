import { describe, expect, it } from 'vitest';
import type { TaskPriority, TaskStatus } from '../graphql/operations';
import {
  burnup,
  byAssignee,
  byPriority,
  dashboardStats,
  forecast,
  formatDays,
  leadTimes,
  nextTasks,
  percentile,
  periodStart,
  seededRandom,
  startOfWeek,
  watchlist,
  weeklyBuckets,
  type StatTask,
} from './taskStats';

// Vendredi 24 octobre 2026, 15 h (heure locale) ; la semaine en cours commence le lundi 19.
const NOW = new Date(2026, 9, 24, 15, 0, 0);
const iso = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();

let seq = 0;
function task(p: Partial<StatTask> & { status?: TaskStatus; priority?: TaskPriority } = {}): StatTask {
  seq++;
  const createdAt = p.createdAt ?? iso(2026, 10, 1);
  return {
    id: `t${seq}`,
    title: `Tâche ${seq}`,
    status: 'TODO',
    priority: 'MEDIUM',
    createdAt,
    updatedAt: p.updatedAt ?? createdAt,
    completedAt: null,
    dueDate: null,
    statusTag: null,
    assignee: null,
    session: null,
    ...p,
  };
}
const done = (createdAt: string, completedAt: string, extra: Partial<StatTask> = {}) => task({ status: 'DONE', createdAt, completedAt, updatedAt: completedAt, ...extra });

describe('calendrier', () => {
  it('commence la semaine le lundi et la période weeks-1 semaines avant', () => {
    expect(startOfWeek(NOW).getTime()).toBe(new Date(2026, 9, 19).getTime());
    expect(startOfWeek(new Date(2026, 9, 19, 3)).getTime()).toBe(new Date(2026, 9, 19).getTime());
    expect(startOfWeek(new Date(2026, 9, 25, 23)).getTime()).toBe(new Date(2026, 9, 19).getTime()); // dimanche
    expect(periodStart(NOW, 4).getTime()).toBe(new Date(2026, 9, 28 - 30).getTime()); // lundi 28 septembre
  });
});

describe('weeklyBuckets', () => {
  it('compte créées, terminées et annulées par semaine, la semaine en cours en dernier', () => {
    const tasks = [
      done(iso(2026, 10, 5), iso(2026, 10, 7)), // créée et terminée semaine du 5
      done(iso(2026, 10, 6), iso(2026, 10, 20)), // créée semaine du 5, terminée semaine en cours
      task({ status: 'CANCELLED', createdAt: iso(2026, 10, 13), updatedAt: iso(2026, 10, 14) }),
      task({ createdAt: iso(2026, 9, 1) }), // avant la période
      done(iso(2026, 9, 1), iso(2026, 10, 30)), // dans le futur : ignorée
    ];
    const b = weeklyBuckets(tasks, NOW, 4);
    expect(b.map((x) => x.label.replace(/ /g, ' '))).toEqual(['28 sept.', '5 oct.', '12 oct.', '19 oct.']);
    expect(b.map((x) => [x.created, x.done, x.cancelled])).toEqual([
      [0, 0, 0],
      [2, 1, 0],
      [1, 0, 1],
      [0, 1, 0],
    ]);
  });
});

describe('burnup', () => {
  it('donne périmètre et terminées à la fin de chaque jour, les annulées sortant du périmètre', () => {
    const tasks = [
      done(iso(2026, 10, 19, 9), iso(2026, 10, 21, 9)),
      task({ createdAt: iso(2026, 10, 20) }),
      task({ status: 'CANCELLED', createdAt: iso(2026, 10, 19), updatedAt: iso(2026, 10, 22) }),
    ];
    const pts = burnup(tasks, NOW, 1);
    expect(pts.map((p) => p.date.getDate())).toEqual([19, 20, 21, 22, 23, 24]);
    expect(pts.map((p) => p.scope)).toEqual([2, 3, 3, 2, 2, 2]);
    expect(pts.map((p) => p.done)).toEqual([0, 0, 1, 1, 1, 1]);
  });

  it("ne compte pas pour aujourd'hui ce qui arrive après l'instant courant", () => {
    const pts = burnup([task({ createdAt: new Date(2026, 9, 24, 18).toISOString() })], NOW, 1);
    expect(pts[pts.length - 1].scope).toBe(0);
  });
});

describe('leadTimes et percentile', () => {
  it('mesure création → terminée des tâches terminées dans la période, triées', () => {
    const tasks = [done(iso(2026, 10, 1), iso(2026, 10, 21)), done(iso(2026, 10, 20, 10), iso(2026, 10, 20, 22)), done(iso(2026, 8, 1), iso(2026, 9, 1))];
    const lt = leadTimes(tasks, NOW, 4);
    expect(lt).toEqual([0.5, 20]);
    expect(percentile(lt, 0.5)).toBe(10.25);
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([1, 2, 3, 4, 5], 0.85)).toBeCloseTo(4.4);
  });
});

describe('forecast', () => {
  it('est déterministe et cohérente avec le débit observé', () => {
    const f1 = forecast(10, [2, 3, 1, 2]);
    const f2 = forecast(10, [2, 3, 1, 2]);
    expect(f1).toEqual(f2);
    expect(f1!.p50).toBeGreaterThanOrEqual(4); // 10 tâches à 2 par semaine en moyenne
    expect(f1!.p50).toBeLessThanOrEqual(6);
    expect(f1!.p85).toBeGreaterThanOrEqual(f1!.p50);
  });

  it('est immédiate sans reste à faire, impossible sans débit', () => {
    expect(forecast(0, [0, 0])).toEqual({ p50: 0, p85: 0 });
    expect(forecast(5, [0, 0, 0])).toBeNull();
    expect(forecast(5, [])).toBeNull();
  });

  it('réserve les semaines sans débit : la prévision s’allonge quand elles dominent', () => {
    const steady = forecast(6, [2, 2, 2, 2])!;
    const sparse = forecast(6, [2, 0, 0, 0])!;
    expect(sparse.p50).toBeGreaterThan(steady.p50);
    expect(seededRandom(1)()).toBeLessThan(1);
  });
});

describe('répartitions', () => {
  it('par priorité dans l’ordre urgente → basse, à faire et en cours séparées', () => {
    const open = [task({ priority: 'URGENT' }), task({ priority: 'URGENT', status: 'IN_PROGRESS' }), task({ priority: 'LOW' })];
    expect(byPriority(open)).toEqual([
      { key: 'URGENT', label: 'Urgente', todo: 1, inProgress: 1 },
      { key: 'HIGH', label: 'Haute', todo: 0, inProgress: 0 },
      { key: 'MEDIUM', label: 'Moyenne', todo: 0, inProgress: 0 },
      { key: 'LOW', label: 'Basse', todo: 1, inProgress: 0 },
    ]);
  });

  it('par responsable : les plus chargés d’abord, « Autres » puis « Sans responsable » à la fin', () => {
    const a = { name: 'Ana', email: 'ana@x.io' };
    const open = [
      task({ assignee: a }),
      task({ assignee: a, status: 'IN_PROGRESS' }),
      task({ assignee: { name: 'Bob', email: null } }),
      task({ assignee: { name: null, email: 'cy@x.io' } }),
      task(),
    ];
    const rows = byAssignee(open, 1);
    expect(rows.map((r) => [r.label, r.todo, r.inProgress])).toEqual([
      ['Ana', 1, 1],
      ['Autres (2)', 2, 0],
      ['Sans responsable', 1, 0],
    ]);
  });
});

describe('listes', () => {
  it('nextTasks : à faire par priorité, échéance puis ancienneté', () => {
    const tasks = [
      task({ priority: 'LOW', createdAt: iso(2026, 10, 1) }),
      task({ priority: 'HIGH', dueDate: '2026-11-02' }),
      task({ priority: 'HIGH', dueDate: '2026-10-30' }),
      task({ priority: 'HIGH', createdAt: iso(2026, 9, 1) }),
      task({ priority: 'URGENT', status: 'IN_PROGRESS' }),
    ];
    expect(nextTasks(tasks, 3).map((t) => t.id)).toEqual([tasks[2].id, tasks[1].id, tasks[3].id]);
  });

  it('watchlist : une raison par tâche, la plus grave d’abord', () => {
    const running = { id: 's', name: 's', status: 'RUNNING' as const, activity: 'BUSY' as const, worksession: null };
    const tasks = [
      task({ dueDate: '2026-10-20' }),
      task({ dueDate: '2026-10-27', priority: 'LOW' }),
      task({ status: 'IN_PROGRESS', statusTag: 'bloquée : attend la clé' }),
      task({ status: 'IN_PROGRESS', updatedAt: iso(2026, 10, 15) }),
      task({ status: 'IN_PROGRESS', updatedAt: iso(2026, 10, 15), session: running }),
      task({ priority: 'URGENT' }),
      task({ priority: 'URGENT', session: running }),
      task({ status: 'DONE', dueDate: '2026-10-01', completedAt: iso(2026, 10, 2) }),
    ];
    const w = watchlist(tasks, NOW);
    expect(w.map((x) => [x.task.id, x.reason])).toEqual([
      [tasks[0].id, 'overdue'],
      [tasks[2].id, 'blocked'],
      [tasks[5].id, 'urgent_idle'],
      [tasks[3].id, 'stale'],
      [tasks[1].id, 'due_soon'],
    ]);
    expect(w[0].detail).toBe('depuis 4 j');
  });
});

describe('dashboardStats', () => {
  it('assemble les indicateurs', () => {
    const busy = { id: 's1', name: 's1', status: 'RUNNING' as const, activity: 'BUSY' as const, worksession: null };
    const idle = { id: 's2', name: 's2', status: 'RUNNING' as const, activity: 'IDLE' as const, worksession: null };
    const tasks = [
      task({ priority: 'URGENT', dueDate: '2026-10-20' }),
      task({ status: 'IN_PROGRESS', session: busy }),
      task({ status: 'IN_PROGRESS', session: idle, dueDate: '2026-10-28' }),
      task({ status: 'IN_PROGRESS', statusTag: 'bloquée' }),
      done(iso(2026, 10, 5), iso(2026, 10, 8)),
      done(iso(2026, 10, 12), iso(2026, 10, 14)),
      done(iso(2026, 10, 20), iso(2026, 10, 22)),
      task({ status: 'CANCELLED', createdAt: iso(2026, 10, 13), updatedAt: iso(2026, 10, 14) }),
    ];
    const s = dashboardStats(tasks, NOW, 4);
    expect(s).toMatchObject({ open: 4, todo: 1, inProgress: 3, important: 1, working: 1, waiting: 1, unattended: 1, blocked: 1, overdue: 1, dueSoon: 1, doneWeek: 1, donePrevWeek: 1, donePeriod: 3, cancelledPeriod: 1 });
    // Semaines révolues : 28 sept. (0), 5 oct. (1), 12 oct. (1) ; la semaine en cours est exclue du débit.
    expect(s.throughput).toEqual({ mean: 2 / 3, min: 0, max: 1, weeks: 3 });
    expect(s.leadTime.count).toBe(3);
    expect(s.leadTime.median).toBe(2);
    expect(s.forecast).not.toBeNull();
    expect(s.forecastDates!.p50.getTime()).toBeGreaterThan(NOW.getTime());
    expect(s.burnup).toHaveLength(27);
    expect(s.burnup[s.burnup.length - 1]).toMatchObject({ scope: 7, done: 3 });
  });

  it('sans aucune tâche terminée, la prévision est absente et le débit nul', () => {
    const s = dashboardStats([task(), task()], NOW, 8);
    expect(s.forecast).toBeNull();
    expect(s.throughput.mean).toBe(0);
    expect(s.leadTime).toEqual({ median: 0, p85: 0, count: 0 });
  });
});

describe('formatDays', () => {
  it('arrondit lisiblement', () => {
    expect(formatDays(0.01)).toBe('< 1 h');
    expect(formatDays(0.5)).toBe('12 h');
    expect(formatDays(1.5)).toBe('1.5 j');
    expect(formatDays(1)).toBe('1 j');
    expect(formatDays(12.4)).toBe('12 j');
  });
});
