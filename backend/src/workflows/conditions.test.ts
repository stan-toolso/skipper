import { describe, expect, it } from 'vitest';
import { conditionHolds, conditionPaths, conditionProblems, describeCondition, type ConditionGroup } from './conditions.js';

const ctx = { input: { env: 'prod', limit: '10' }, nodes: { plan: { json: { approved: true, size: 12, title: 'Refonte panier' } } } };
const group = (match: 'all' | 'any', ...items: ConditionGroup['items']): ConditionGroup => ({ kind: 'group', match, items });

describe('conditionHolds', () => {
  it('un groupe vide tient ; all = et, any = ou', () => {
    expect(conditionHolds(group('all'), ctx)).toBe(true);
    expect(conditionHolds(group('all', { kind: 'rule', path: 'input.env', operator: 'is', value: 'prod' }, { kind: 'rule', path: 'nodes.plan.json.approved', operator: 'isTrue' }), ctx)).toBe(true);
    expect(conditionHolds(group('all', { kind: 'rule', path: 'input.env', operator: 'is', value: 'dev' }, { kind: 'rule', path: 'nodes.plan.json.approved', operator: 'isTrue' }), ctx)).toBe(false);
    expect(conditionHolds(group('any', { kind: 'rule', path: 'input.env', operator: 'is', value: 'dev' }, { kind: 'rule', path: 'nodes.plan.json.approved', operator: 'isTrue' }), ctx)).toBe(true);
  });
  it('la valeur comparée peut être un modèle', () => {
    expect(conditionHolds(group('all', { kind: 'rule', path: 'nodes.plan.json.size', operator: 'greaterThan', value: '{{input.limit}}' }), ctx)).toBe(true);
    expect(conditionHolds(group('all', { kind: 'rule', path: 'nodes.plan.json.size', operator: 'atMost', value: '{{input.limit}}' }), ctx)).toBe(false);
  });
  it('texte et vacuité', () => {
    expect(conditionHolds(group('all', { kind: 'rule', path: 'nodes.plan.json.title', operator: 'contains', value: 'panier' }), ctx)).toBe(true);
    expect(conditionHolds(group('all', { kind: 'rule', path: 'nodes.plan.json.title', operator: 'notContains', value: 'panier' }), ctx)).toBe(false);
    expect(conditionHolds(group('all', { kind: 'rule', path: 'nodes.plan.json.title', operator: 'matches', value: '^refonte' }), ctx)).toBe(true);
    expect(conditionHolds(group('all', { kind: 'rule', path: 'input.absent', operator: 'isEmpty' }), ctx)).toBe(true);
    expect(conditionHolds(group('all', { kind: 'rule', path: 'input.absent', operator: 'isNotEmpty' }), ctx)).toBe(false);
  });
  it('groupes imbriqués', () => {
    const nested = group('all', { kind: 'rule', path: 'input.env', operator: 'is', value: 'prod' }, group('any', { kind: 'rule', path: 'input.env', operator: 'is', value: 'dev' }, { kind: 'rule', path: 'nodes.plan.json.size', operator: 'atLeast', value: '12' }));
    expect(conditionHolds(nested, ctx)).toBe(true);
  });
});

describe('conditionProblems / conditionPaths / describeCondition', () => {
  it('signale une condition sans règle, un chemin vide, une regex invalide, un groupe vide et une imbrication trop profonde', () => {
    expect(conditionProblems(group('all'))).toEqual(['Ajoutez une règle à la condition']);
    const problems = conditionProblems(group('all', { kind: 'rule', path: '', operator: 'is', value: 'x' }, { kind: 'rule', path: 'a', operator: 'matches', value: '(' }, group('any')));
    expect(problems.some((p) => /quelle valeur/.test(p))).toBe(true);
    expect(problems.some((p) => /régulière invalide/.test(p))).toBe(true);
    expect(problems.some((p) => /groupe .* vide/.test(p))).toBe(true);
    const deep = group('all', group('all', group('all', group('all', group('all', { kind: 'rule', path: 'a', operator: 'isTrue' })))));
    expect(conditionProblems(deep).some((p) => /imbrique trop/.test(p))).toBe(true);
  });
  it('liste les chemins des règles et des modèles de valeur', () => {
    const paths = conditionPaths(group('all', { kind: 'rule', path: 'input.env', operator: 'is', value: '{{nodes.plan.json.env}}' }, group('any', { kind: 'rule', path: 'nodes.plan.json.approved', operator: 'isTrue' })));
    expect(paths).toEqual(expect.arrayContaining(['input.env', 'nodes.plan.json.env', 'nodes.plan.json.approved']));
  });
  it('décrit lisiblement', () => {
    expect(describeCondition(group('any', { kind: 'rule', path: 'input.env', operator: 'is', value: 'prod' }, { kind: 'rule', path: 'input.x', operator: 'isEmpty' }))).toBe('input.env est "prod" ou input.x est vide');
  });
});
