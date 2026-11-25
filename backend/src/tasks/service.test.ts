import { describe, expect, it } from 'vitest';
import { describeTaskChanges, finishTaskHint, finishTaskInstruction, normalizeFields, normalizePerson, normalizeStatusTag, normalizeTags, reviewStatusOf } from './service.js';
import { DEFAULT_TASK_STATUSES, normalizeTaskStatuses } from './statuses.js';
import type { Task } from './types.js';

const base: Task = {
  id: 't1',
  projectId: 'p1',
  title: 'Corriger le bug',
  summary: null,
  description: '',
  status: 'todo',
  priority: 'medium',
  sessionId: null,
  sessionIds: [],
  dependsOnIds: [],
  blockedByIds: [],
  dependentIds: [],
  autoStartWhenUnblocked: false,
  autoStartById: null,
  branch: null,
  createdByType: 'user',
  createdBySessionId: null,
  dueDate: null,
  customFields: [],
  statusTag: null,
  tags: [],
  assignee: null,
  reporter: null,
} as unknown as Task;

describe('normalizePerson', () => {
  it('null quand rien n’est renseigné, e-mail en minuscules sinon', () => {
    expect(normalizePerson(null, 'responsable')).toBeNull();
    expect(normalizePerson({ name: ' ', email: '' }, 'responsable')).toBeNull();
    expect(normalizePerson({ name: ' Alice ', email: 'Alice@Example.com' }, 'responsable')).toEqual({ name: 'Alice', email: 'alice@example.com' });
    expect(normalizePerson({ email: 'bob@example.com' }, 'rapporteur')).toEqual({ name: null, email: 'bob@example.com' });
  });
  it('refuse un e-mail invalide', () => {
    expect(() => normalizePerson({ email: 'pas-un-email' }, 'responsable')).toThrow(/E-mail du responsable invalide/);
  });
});

describe('normalizeFields', () => {
  it('ignore les lignes vides, garde l’ordre, refuse les doublons et les clés manquantes', () => {
    expect(normalizeFields([{ key: ' Client ', value: ' ACME ' }, { key: '', value: '' }, { key: 'Ref', value: '42' }])).toEqual([
      { key: 'Client', value: 'ACME' },
      { key: 'Ref', value: '42' },
    ]);
    expect(() => normalizeFields([{ key: 'a', value: '1' }, { key: 'A', value: '2' }])).toThrow(/en double/);
    expect(() => normalizeFields([{ key: '', value: 'x' }])).toThrow(/doit avoir une clé/);
  });
});

describe('describeTaskChanges', () => {
  it('rien quand rien de visible n’a changé', () => {
    expect(describeTaskChanges(base, { ...base })).toEqual([]);
  });
  it('décrit chaque champ modifié, en français', () => {
    const after: Task = {
      ...base,
      title: 'Corriger le bug du panier',
      status: 'in_progress',
      priority: 'high',
      dueDate: '2026-11-01',
      assignee: { name: 'Alice', email: 'alice@example.com' },
      customFields: [{ key: 'Client', value: 'ACME' }],
      description: 'Ligne 1\nLigne 2',
    };
    const lines = describeTaskChanges(base, after);
    expect(lines).toEqual([
      '- Titre : « Corriger le bug » → « Corriger le bug du panier »',
      '- Statut : à faire → en cours',
      '- Priorité : moyenne → haute',
      '- Échéance : aucune → 2026-11-01',
      '- Responsable : personne → Alice <alice@example.com>',
      '- Champ « Client » : aucun → « ACME »',
      '- Description, nouveau texte :\n  Ligne 1\n  Ligne 2',
    ]);
  });
  it('signale un champ retiré ou modifié', () => {
    const before = { ...base, customFields: [{ key: 'Client', value: 'ACME' }, { key: 'Ref', value: '1' }] };
    const after = { ...base, customFields: [{ key: 'client', value: 'Globex' }] };
    expect(describeTaskChanges(before, after)).toEqual(['- Champ « client » : « ACME » → « Globex »', '- Champ « Ref » retiré']);
  });
});

describe('étiquettes', () => {
  it('nettoie les étiquettes : espaces, vides et doublons sans tenir compte de la casse', () => {
    expect(normalizeTags(['  Front ', 'front', '', 'API  REST'])).toEqual(['Front', 'API REST']);
    expect(normalizeTags(undefined)).toBeUndefined();
  });
  it("vide l'étiquette d'état blanche, refuse une étiquette trop longue", () => {
    expect(normalizeStatusTag('  ')).toBeNull();
    expect(normalizeStatusTag(undefined)).toBeUndefined();
    expect(() => normalizeStatusTag('x'.repeat(41))).toThrow();
  });
  it("décrit les changements d'étiquettes", () => {
    expect(describeTaskChanges(base, { ...base, statusTag: 'en revue', tags: ['front'] })).toEqual(["- Étiquette d'état : aucune → « en revue »", '- Étiquettes : aucune → front']);
  });
  it('décrit les changements du résumé', () => {
    expect(describeTaskChanges(base, { ...base, summary: 'Afficher un résumé avant la description' })).toEqual(['- Résumé, nouveau texte : Afficher un résumé avant la description']);
    expect(describeTaskChanges({ ...base, summary: 'Ancien' }, base)).toEqual(['- Résumé retiré']);
  });
});

describe('fin de l’instruction d’une tâche', () => {
  it('nomme le statut « à valider » du projet, avec la date de réveil pour une vérification différée', () => {
    const text = finishTaskInstruction(DEFAULT_TASK_STATUSES);
    expect(text).toMatch(/passe-la en `done`/);
    expect(text).toMatch(/`review` « À valider »/);
    expect(text).toMatch(/wake_at/);
    expect(finishTaskHint(DEFAULT_TASK_STATUSES)).toMatch(/`review` « À valider »/);
    // Sans statuts (projet incomplet, test) : ceux par défaut.
    expect(reviewStatusOf(null)?.key).toBe('review');
  });

  it('reprend le statut propre au projet, et s’en passe quand le projet n’en a pas', () => {
    const custom = normalizeTaskStatuses([
      { label: 'Prête', category: 'todo' },
      { label: 'Développement', category: 'in_progress' },
      { label: 'Recette client', category: 'in_progress', attention: true },
      { label: 'Livrée', category: 'done' },
      { label: 'Abandonnée', category: 'cancelled' },
    ]);
    expect(finishTaskInstruction(custom)).toMatch(/`recette_client` « Recette client »/);
    const plain = normalizeTaskStatuses([
      { label: 'Prête', category: 'todo' },
      { label: 'Développement', category: 'in_progress' },
      { label: 'Livrée', category: 'done' },
      { label: 'Abandonnée', category: 'cancelled' },
    ]);
    expect(reviewStatusOf(plain)).toBeNull();
    expect(finishTaskInstruction(plain)).not.toMatch(/state/);
    expect(finishTaskInstruction(plain)).toMatch(/laisse-la en cours/);
  });
});
