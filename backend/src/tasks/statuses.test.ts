import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_STATUSES, defaultStatusOf, effectiveStatus, findStatus, normalizeTaskStatuses, projectTaskStatuses, resolveTaskState } from './statuses.js';

describe('statuts de tâches', () => {
  it('a « À trier » et « À valider » par défaut, avec un statut par défaut par catégorie', () => {
    expect(DEFAULT_TASK_STATUSES.map((s) => s.label)).toEqual(['À trier', 'À faire', 'En cours', 'À valider', 'Terminée', 'Annulée']);
    expect(defaultStatusOf(DEFAULT_TASK_STATUSES, 'todo').key).toBe('todo');
    expect(defaultStatusOf(DEFAULT_TASK_STATUSES, 'in_progress').key).toBe('in_progress');
    expect(normalizeTaskStatuses(DEFAULT_TASK_STATUSES)).toEqual(DEFAULT_TASK_STATUSES);
  });

  it('normalise une liste choisie : clés dérivées et uniques, un seul défaut par catégorie', () => {
    const out = normalizeTaskStatuses([
      { label: 'Backlog', category: 'todo' },
      { label: 'Prête', category: 'todo', isDefault: true },
      { label: 'Développement', category: 'in_progress' },
      { label: 'Recette client', category: 'in_progress', attention: true, isDefault: true },
      { label: 'Livrée', category: 'done' },
      { label: 'Abandonnée', category: 'cancelled' },
    ]);
    expect(out.map((s) => s.key)).toEqual(['backlog', 'prete', 'developpement', 'recette_client', 'livree', 'abandonnee']);
    expect(out.filter((s) => s.isDefault).map((s) => s.key)).toEqual(['prete', 'recette_client', 'livree', 'abandonnee']);
  });

  it('refuse une catégorie vide, des doublons et une clé invalide', () => {
    expect(() => normalizeTaskStatuses([{ label: 'A', category: 'todo' }, { label: 'B', category: 'in_progress' }, { label: 'C', category: 'done' }])).toThrow(/Annulée/);
    const base = [
      { label: 'B', category: 'in_progress' as const },
      { label: 'C', category: 'done' as const },
      { label: 'D', category: 'cancelled' as const },
    ];
    expect(() => normalizeTaskStatuses([{ label: 'A', category: 'todo' }, { label: 'a', category: 'todo' }, ...base])).toThrow(/même libellé/);
    expect(() => normalizeTaskStatuses([{ key: 'Pas bon!', label: 'A', category: 'todo' }, ...base])).toThrow(/Clé de statut invalide/);
    expect(() => normalizeTaskStatuses([{ key: 'x', label: 'A', category: 'todo' }, { key: 'x', label: 'E', category: 'todo' }, ...base])).toThrow(/même clé/);
  });

  it('retombe sur les statuts par défaut pour une colonne vide ou illisible', () => {
    expect(projectTaskStatuses(null)).toBe(DEFAULT_TASK_STATUSES);
    expect(projectTaskStatuses([{ label: 'seul', category: 'todo' }])).toBe(DEFAULT_TASK_STATUSES);
  });

  it('donne le statut effectif : le sien, ou celui par défaut de la catégorie', () => {
    expect(effectiveStatus(DEFAULT_TASK_STATUSES, { status: 'in_progress', state: 'review' }).label).toBe('À valider');
    expect(effectiveStatus(DEFAULT_TASK_STATUSES, { status: 'in_progress', state: null }).label).toBe('En cours');
    // Statut d'une autre catégorie (tâche passée à done par une requête directe) : celui par défaut.
    expect(effectiveStatus(DEFAULT_TASK_STATUSES, { status: 'done', state: 'review' }).label).toBe('Terminée');
    expect(effectiveStatus(DEFAULT_TASK_STATUSES, { status: 'todo', state: 'disparu' }).label).toBe('À faire');
  });

  it('retrouve un statut par sa clé ou son libellé', () => {
    expect(findStatus(DEFAULT_TASK_STATUSES, 'review')?.key).toBe('review');
    expect(findStatus(DEFAULT_TASK_STATUSES, 'à valider')?.key).toBe('review');
    expect(findStatus(DEFAULT_TASK_STATUSES, 'A TRIER')?.key).toBe('triage');
    expect(findStatus(DEFAULT_TASK_STATUSES, 'inconnu')).toBeUndefined();
  });

  it('résout ce qu’il faut écrire', () => {
    expect(resolveTaskState(DEFAULT_TASK_STATUSES, { state: 'review' }, null)).toEqual({ status: 'in_progress', state: 'review' });
    expect(resolveTaskState(DEFAULT_TASK_STATUSES, { status: 'in_progress' }, { status: 'todo', state: 'triage' })).toEqual({ status: 'in_progress', state: 'in_progress' });
    // Catégorie inchangée : le statut est gardé (claim d'une tâche déjà « à valider »).
    expect(resolveTaskState(DEFAULT_TASK_STATUSES, { status: 'in_progress' }, { status: 'in_progress', state: 'review' })).toEqual({ status: 'in_progress', state: 'review' });
    expect(resolveTaskState(DEFAULT_TASK_STATUSES, {}, { status: 'todo', state: null })).toBeNull();
    expect(() => resolveTaskState(DEFAULT_TASK_STATUSES, { state: 'review', status: 'done' }, null)).toThrow(/catégorie/);
    expect(() => resolveTaskState(DEFAULT_TASK_STATUSES, { state: 'nope' }, null)).toThrow(/Statut inconnu/);
  });
});
