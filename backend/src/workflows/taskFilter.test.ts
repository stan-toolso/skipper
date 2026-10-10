import { describe, expect, it } from 'vitest';
import type { Task } from '../tasks/types.js';
import { taskFilterProblems, taskMatches, type TaskFilterGroup } from './taskFilter.js';

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: 't1',
    projectId: 'p1',
    title: 'Corriger le panier',
    description: 'Le total est faux quand un article est retiré.',
    status: 'todo',
    priority: 'high',
    sessionId: null,
    branch: null,
    createdByType: 'human',
    createdBySessionId: null,
    dueDate: '2026-10-20',
    customFields: [{ key: 'Client', value: 'ACME' }],
    assignee: { name: 'Alice', email: 'alice@example.com' },
    reporter: null,
    commentCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...over,
  }) as Task;
const all = (...items: TaskFilterGroup['items']): TaskFilterGroup => ({ kind: 'group', match: 'all', items });
const any = (...items: TaskFilterGroup['items']): TaskFilterGroup => ({ kind: 'group', match: 'any', items });

describe('taskMatches', () => {
  it('un filtre vide accepte tout', () => {
    expect(taskMatches(all(), task())).toBe(true);
  });
  it('texte, sans tenir compte de la casse', () => {
    expect(taskMatches(all({ kind: 'rule', field: 'title', operator: 'contains', value: 'PANIER' }), task())).toBe(true);
    expect(taskMatches(all({ kind: 'rule', field: 'title', operator: 'startsWith', value: 'corriger' }), task())).toBe(true);
    expect(taskMatches(all({ kind: 'rule', field: 'description', operator: 'notContains', value: 'faux' }), task())).toBe(false);
    expect(taskMatches(all({ kind: 'rule', field: 'title', operator: 'matches', value: 'pan(ier|ache)' }), task())).toBe(true);
  });
  it('listes : statut, priorité, origine ; bornes de priorité', () => {
    expect(taskMatches(all({ kind: 'rule', field: 'status', operator: 'anyOf', values: ['todo', 'in_progress'] }), task())).toBe(true);
    expect(taskMatches(all({ kind: 'rule', field: 'priority', operator: 'noneOf', values: ['high'] }), task())).toBe(false);
    expect(taskMatches(all({ kind: 'rule', field: 'priority', operator: 'atLeast', value: 'medium' }), task())).toBe(true);
    expect(taskMatches(all({ kind: 'rule', field: 'priority', operator: 'atMost', value: 'medium' }), task())).toBe(false);
    expect(taskMatches(all({ kind: 'rule', field: 'createdBy', operator: 'anyOf', values: ['agent'] }), task())).toBe(false);
  });
  it('dates et vacuité', () => {
    expect(taskMatches(all({ kind: 'rule', field: 'dueDate', operator: 'before', value: '2026-11-01' }), task())).toBe(true);
    expect(taskMatches(all({ kind: 'rule', field: 'dueDate', operator: 'after', value: '2026-11-01' }), task())).toBe(false);
    expect(taskMatches(all({ kind: 'rule', field: 'dueDate', operator: 'isEmpty' }), task({ dueDate: null }))).toBe(true);
    expect(taskMatches(all({ kind: 'rule', field: 'reporter', operator: 'isEmpty' }), task())).toBe(true);
    expect(taskMatches(all({ kind: 'rule', field: 'assignee', operator: 'isNotEmpty' }), task())).toBe(true);
  });
  it('personnes (nom ou e-mail) et champs personnalisés (clé insensible à la casse)', () => {
    expect(taskMatches(all({ kind: 'rule', field: 'assignee', operator: 'is', value: 'alice@example.com' }), task())).toBe(true);
    expect(taskMatches(all({ kind: 'rule', field: 'assignee', operator: 'isNot', value: 'alice' }), task())).toBe(false);
    expect(taskMatches(all({ kind: 'rule', field: 'customField', key: 'client', operator: 'is', value: 'acme' }), task())).toBe(true);
    expect(taskMatches(all({ kind: 'rule', field: 'customField', key: 'absent', operator: 'isEmpty' }), task())).toBe(true);
  });
  it('groupes imbriqués', () => {
    const filter = all({ kind: 'rule', field: 'status', operator: 'anyOf', values: ['todo'] }, any({ kind: 'rule', field: 'priority', operator: 'anyOf', values: ['urgent'] }, { kind: 'rule', field: 'title', operator: 'contains', value: 'panier' }));
    expect(taskMatches(filter, task())).toBe(true);
    expect(taskMatches(filter, task({ title: 'Autre' }))).toBe(false);
  });
});

describe('taskFilterProblems', () => {
  it('signale un opérateur inadapté au champ, une liste vide, une clé manquante', () => {
    const problems = taskFilterProblems(all({ kind: 'rule', field: 'status', operator: 'contains', value: 'x' }, { kind: 'rule', field: 'priority', operator: 'anyOf', values: [] }, { kind: 'rule', field: 'customField', operator: 'is', value: 'x' }));
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(taskFilterProblems(all({ kind: 'rule', field: 'title', operator: 'contains', value: 'x' }))).toEqual([]);
  });
});
