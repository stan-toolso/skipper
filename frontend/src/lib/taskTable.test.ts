import { describe, expect, it } from 'vitest';
import type { Task } from '../graphql/operations';
import { applyFilters, defaultLayout, loadLayout, matchesFilter, moveColumn, normalizeLayout, shiftColumn, sortTasks, TASK_COLUMNS, visibleColumns } from './taskTable';

const task = (over: Partial<Task> & { id: string }): Task => ({
  title: 'Tâche',
  description: '',
  status: 'TODO',
  statusTag: null,
  tags: [],
  priority: 'MEDIUM',
  dueDate: null,
  createdByType: 'human',
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:00:00Z',
  completedAt: null,
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
  ...over,
});

const now = new Date('2026-10-24T12:00:00');

describe('disposition des colonnes', () => {
  it('par défaut : toutes les colonnes, les secondaires masquées, actions en dernier', () => {
    const l = defaultLayout();
    expect(l.order).toHaveLength(TASK_COLUMNS.length);
    expect(l.order.at(-1)).toBe('actions');
    expect(l.hidden).toContain('reporter');
    expect(l.hidden).not.toContain('title');
    expect(visibleColumns(l).map((c) => c.key)).toContain('actions');
  });

  it('remet d’aplomb une disposition enregistrée : colonnes inconnues ignorées, nouvelles ajoutées à leur place', () => {
    const l = normalizeLayout({ order: ['status', 'bidule', 'title', 'actions', 'project'], hidden: ['title', 'bidule'], widths: { title: 10, status: 'x', project: 200 }, sort: { key: 'actions', dir: 'asc' } });
    // L'ordre enregistré est respecté entre colonnes connues.
    expect(l.order.indexOf('status')).toBeLessThan(l.order.indexOf('title'));
    expect(l.order.indexOf('title')).toBeLessThan(l.order.indexOf('project'));
    expect(l.order.at(-1)).toBe('actions');
    expect(new Set(l.order).size).toBe(TASK_COLUMNS.length);
    // La nouvelle colonne « statusTag » suit « status », sa voisine par défaut.
    expect(l.order.indexOf('statusTag')).toBe(l.order.indexOf('status') + 1);
    expect(l.hidden).toContain('title');
    // Les colonnes absentes de l'enregistrement gardent leur visibilité par défaut.
    expect(l.hidden).toContain('reporter');
    expect(l.hidden).not.toContain('priority');
    expect(l.widths.title).toBe(140); // largeur minimale
    expect(l.widths.status).toBeUndefined();
    expect(l.widths.project).toBe(200);
    expect(l.sort).toEqual({ key: 'createdAt', dir: 'desc' }); // actions n'est pas triable
  });

  it('lit un stockage vide ou corrompu sans planter', () => {
    expect(loadLayout({ getItem: () => null })).toEqual(defaultLayout());
    expect(loadLayout({ getItem: () => '{oops' })).toEqual(defaultLayout());
    expect(loadLayout(null)).toEqual(defaultLayout());
  });

  it('déplace une colonne avant une autre, jamais après les actions', () => {
    const order = defaultLayout().order;
    const moved = moveColumn(order, 'priority', 'title');
    expect(moved[0]).toBe('priority');
    expect(moved[1]).toBe('title');
    expect(moved.at(-1)).toBe('actions');
    expect(moveColumn(order, 'priority', null).at(-2)).toBe('priority');
    expect(moveColumn(order, 'actions', 'title')).toBe(order);
    expect(moveColumn(order, 'priority', 'priority')).toBe(order);
  });

  it('décale une colonne d’un cran sans franchir les actions', () => {
    const order = defaultLayout().order;
    expect(shiftColumn(order, 'project', -1).slice(0, 2)).toEqual(['project', 'title']);
    expect(shiftColumn(order, 'title', -1)).toBe(order);
    expect(shiftColumn(order, 'completedAt', 1)).toBe(order);
  });
});

describe('filtres par colonne', () => {
  const tasks = [
    task({ id: 'a', title: 'Échéance du rapport', tags: ['coach', 'qualité'], assignee: { name: 'Amélie', email: 'a@x.io' }, dueDate: '2026-10-20', priority: 'HIGH', createdByType: 'agent' }),
    task({ id: 'b', title: 'Deuxième', dueDate: '2026-10-28', status: 'DONE', project: { id: 'p2', name: 'toolso' } }),
    task({ id: 'c', title: 'Troisième', dueDate: '2026-10-10', status: 'DONE' }),
    task({ id: 'd', title: 'Quatrième', session: { id: 's', name: 'Revue', status: 'RUNNING', activity: 'BUSY', worksession: null } }),
  ];

  it('texte : contient, sans accents ni casse', () => {
    expect(applyFilters(tasks, { title: 'echeance' }).map((t) => t.id)).toEqual(['a']);
    expect(applyFilters(tasks, { tags: 'QUAL' }).map((t) => t.id)).toEqual(['a']);
    expect(applyFilters(tasks, { assignee: 'a@x' }).map((t) => t.id)).toEqual(['a']);
    expect(applyFilters(tasks, { session: 'rev' }).map((t) => t.id)).toEqual(['d']);
    expect(applyFilters(tasks, { title: '  ' })).toBe(tasks);
  });

  it('choix : statut, priorité, origine, projet', () => {
    expect(applyFilters(tasks, { status: 'DONE' }).map((t) => t.id)).toEqual(['b', 'c']);
    expect(applyFilters(tasks, { priority: 'HIGH' }).map((t) => t.id)).toEqual(['a']);
    expect(applyFilters(tasks, { createdBy: 'agent' }).map((t) => t.id)).toEqual(['a']);
    expect(applyFilters(tasks, { project: 'p2' }).map((t) => t.id)).toEqual(['b']);
    expect(applyFilters(tasks, { status: 'DONE', project: 'p1' }).map((t) => t.id)).toEqual(['c']);
  });

  it('échéance : en retard (ouvertes seulement), sous 7 jours, avec, sans', () => {
    expect(applyFilters(tasks, { dueDate: 'overdue' }, now).map((t) => t.id)).toEqual(['a']);
    expect(applyFilters(tasks, { dueDate: 'week' }, now).map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(applyFilters(tasks, { dueDate: 'set' }, now).map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(applyFilters(tasks, { dueDate: 'none' }, now).map((t) => t.id)).toEqual(['d']);
    expect(matchesFilter(tasks[3], 'dueDate', 'week', now)).toBe(false);
  });
});

describe('tri', () => {
  const tasks = [
    task({ id: 'a', title: 'b', priority: 'LOW', dueDate: null, createdAt: '2026-10-01T00:00:00Z' }),
    task({ id: 'b', title: 'A', priority: 'URGENT', dueDate: '2026-11-01', createdAt: '2026-10-03T00:00:00Z' }),
    task({ id: 'c', title: 'c', priority: 'HIGH', dueDate: '2026-10-05', createdAt: '2026-10-02T00:00:00Z' }),
  ];
  const ids = (list: Task[]) => list.map((t) => t.id);

  it('texte sans casse, priorité de l’urgente à la basse, dates', () => {
    expect(ids(sortTasks(tasks, { key: 'title', dir: 'asc' }))).toEqual(['b', 'a', 'c']);
    expect(ids(sortTasks(tasks, { key: 'priority', dir: 'asc' }))).toEqual(['b', 'c', 'a']);
    expect(ids(sortTasks(tasks, { key: 'createdAt', dir: 'desc' }))).toEqual(['b', 'c', 'a']);
  });

  it('les vides restent en fin dans les deux sens, et le tri est stable', () => {
    expect(ids(sortTasks(tasks, { key: 'dueDate', dir: 'asc' }))).toEqual(['c', 'b', 'a']);
    expect(ids(sortTasks(tasks, { key: 'dueDate', dir: 'desc' }))).toEqual(['b', 'c', 'a']);
    expect(ids(sortTasks(tasks, { key: 'assignee', dir: 'asc' }))).toEqual(['a', 'b', 'c']);
  });
});
