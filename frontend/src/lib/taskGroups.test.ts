import { describe, expect, it } from 'vitest';
import type { Task } from '../graphql/operations';
import type { TrackedPullRequestSummary } from '../graphql/pullRequests';
import { groupTasks, laneCounts, matchesSearch, placeTask, type Placement } from './taskGroups';

const task = (over: Partial<Task> & { id: string }): Task => ({
  costUsd: 0,
  title: 'Tâche',
  summary: null,
  description: '',
  status: 'TODO',
  statusTag: null,
  stalledSince: null,
  waitingSince: null,
  wakeAt: null,
  wakeNote: null,
  tags: [],
  priority: 'MEDIUM',
  dueDate: null,
  createdByType: 'human',
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:00:00Z',
  completedAt: null,
  startedAt: null,
  cancelledAt: null,
  customFields: [],
  assignee: null,
  reporter: null,
  commentCount: 0,
  attachmentCount: 0,
  attachments: [],
  branch: null,
  worksession: null,
  project: { id: 'p1', name: 'Curso' },
  session: null,
  createdBySession: null,
  pullRequest: null,
  dependsOn: [],
  blockedBy: [],
  dependents: [],
  autoStartWhenUnblocked: false,
  autoStartBy: null,
  ...over,
});

const now = new Date('2026-11-13T12:00:00');
const pr = (stage: TrackedPullRequestSummary['stage']) => ({ id: 'pr', number: 12, stage }) as TrackedPullRequestSummary;
const place = (tasks: Task[]) => new Map<string, Placement>(tasks.map((t) => [t.id, placeTask(t, now)]));
const ids = (list: Task[]) => list.map((t) => t.id);

describe('rangement par ce qui est attendu', () => {
  it('à traiter : agent arrêté, PR à fusionner, retard, réveil passé, urgente pas commencée', () => {
    expect(placeTask(task({ id: 'a', status: 'IN_PROGRESS', stalledSince: '2026-11-12T00:00:00Z' }), now)).toEqual({ lane: 'attention', reason: 'agent arrêté' });
    expect(placeTask(task({ id: 'b', status: 'IN_PROGRESS', pullRequests: [pr('TO_MERGE')] }), now).reason).toBe('PR à fusionner');
    expect(placeTask(task({ id: 'c', status: 'TODO', dueDate: '2026-11-01' }), now).reason).toBe('en retard');
    expect(placeTask(task({ id: 'd', status: 'IN_PROGRESS', waitingSince: '2026-11-10T00:00:00Z', wakeAt: '2026-11-12T00:00:00Z' }), now).reason).toBe('réveil passé');
    expect(placeTask(task({ id: 'e', priority: 'URGENT' }), now).lane).toBe('attention');
  });

  it('les autres couloirs', () => {
    expect(placeTask(task({ id: 'a', status: 'IN_PROGRESS', pullRequests: [pr('DRAFT')] }), now).lane).toBe('active');
    expect(placeTask(task({ id: 'b', status: 'IN_PROGRESS', waitingSince: '2026-11-10T00:00:00Z', wakeAt: '2026-11-20T00:00:00Z' }), now).lane).toBe('waiting');
    expect(placeTask(task({ id: 'c' }), now).lane).toBe('ready');
    // Bloquée l'emporte sur l'urgence et le retard : rien à faire tant que la dépendance n'est pas terminée.
    expect(placeTask(task({ id: 'd', priority: 'URGENT', dueDate: '2026-11-01', blockedBy: [{ id: 'x' } as Task['blockedBy'][number]] }), now).lane).toBe('blocked');
    expect(placeTask(task({ id: 'e', status: 'DONE', dueDate: '2026-11-01' }), now).lane).toBe('done');
    expect(placeTask(task({ id: 'f', status: 'CANCELLED' }), now).lane).toBe('cancelled');
  });
});

describe('groupes', () => {
  const tasks = [
    task({ id: 'low', priority: 'LOW', createdAt: '2026-10-01T00:00:00Z' }),
    task({ id: 'high-new', priority: 'HIGH', createdAt: '2026-10-10T00:00:00Z' }),
    task({ id: 'high-old', priority: 'HIGH', createdAt: '2026-10-02T00:00:00Z' }),
    task({ id: 'run', status: 'IN_PROGRESS', project: { id: 'p2', name: 'Atlas' } }),
    task({ id: 'old-done', status: 'DONE', completedAt: '2026-11-01T00:00:00Z' }),
    task({ id: 'new-done', status: 'DONE', completedAt: '2026-11-12T00:00:00Z' }),
  ];
  const placements = place(tasks);

  it('par couloir, dans l’ordre, avec l’ordre par pertinence propre à chacun', () => {
    const groups = groupTasks(tasks, 'lane', placements, null);
    expect(groups.map((g) => g.key)).toEqual(['active', 'ready', 'done']);
    // À faire : priorité, puis la plus ancienne ; terminées : la plus récemment fermée d'abord.
    expect(ids(groups[1].tasks)).toEqual(['high-old', 'high-new', 'low']);
    expect(ids(groups[2].tasks)).toEqual(['new-done', 'old-done']);
  });

  it('un tri choisi remplace la pertinence ; autres groupements', () => {
    const byTitle = (l: Task[]) => [...l].sort((a, b) => a.id.localeCompare(b.id));
    expect(ids(groupTasks(tasks, 'lane', placements, byTitle)[1].tasks)).toEqual(['high-new', 'high-old', 'low']);
    expect(groupTasks(tasks, 'project', placements, null).map((g) => g.label)).toEqual(['Atlas', 'Curso']);
    expect(groupTasks(tasks, 'priority', placements, null).map((g) => g.label)).toEqual(['Haute', 'Moyenne', 'Basse']);
    const flat = groupTasks(tasks, 'none', placements, null);
    expect(flat).toHaveLength(1);
    expect(ids(flat[0].tasks).slice(0, 2)).toEqual(['run', 'high-old']);
    expect(groupTasks([], 'none', placements, null)).toEqual([]);
  });

  it('compte par couloir', () => {
    expect(laneCounts(tasks, placements)).toMatchObject({ active: 1, ready: 3, done: 2, attention: 0 });
  });
});

describe('recherche', () => {
  const t = task({ id: 'abcdef12-0000', title: 'Échéance des factures', tags: ['facturation'], assignee: { name: 'Ben', email: 'ben@x.io' } as Task['assignee'], pullRequests: [pr('DRAFT')] });
  it('tous les mots, sans accents ni casse, dans le titre, les étiquettes, le responsable, la PR ou l’identifiant', () => {
    expect(matchesSearch(t, 'echeance BEN')).toBe(true);
    expect(matchesSearch(t, 'factur #12')).toBe(true);
    expect(matchesSearch(t, 'abcdef12')).toBe(true);
    expect(matchesSearch(t, 'echeance chris')).toBe(false);
    expect(matchesSearch(t, '  ')).toBe(true);
  });
});
