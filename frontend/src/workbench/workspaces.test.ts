import { describe, expect, it } from 'vitest';
import { sessionTree } from './workspaces';

const s = (id: string, parent: string | null = null) => ({ id, name: `Session ${id}`, parentSession: parent ? { id: parent } : null });

describe('sessionTree', () => {
  it('laisse à plat des sessions lancées par des humains', () => {
    const tree = sessionTree([s('a'), s('b')]);
    expect(tree.map((n) => [n.session.id, n.depth, n.byAgent, n.parentName])).toEqual([
      ['a', 0, false, null],
      ['b', 0, false, null],
    ]);
  });

  it('range chaque session fille sous sa parente, dans l’ordre de la liste', () => {
    const tree = sessionTree([s('c1', 'p'), s('p'), s('x'), s('c2', 'p'), s('cc', 'c1')]);
    expect(tree.map((n) => [n.session.id, n.depth, n.parentName])).toEqual([
      ['p', 0, null],
      ['c1', 1, 'Session p'],
      ['cc', 2, 'Session c1'],
      ['c2', 1, 'Session p'],
      ['x', 0, null],
    ]);
    expect(tree.find((n) => n.session.id === 'c1')?.byAgent).toBe(true);
  });

  it('garde au premier niveau une session dont la parente n’est pas listée, en la marquant', () => {
    const tree = sessionTree([s('orphan', 'elsewhere')]);
    expect(tree).toEqual([{ session: s('orphan', 'elsewhere'), depth: 0, byAgent: true, parentName: null }]);
  });

  it('ne boucle pas sur une session qui se référence elle-même', () => {
    expect(sessionTree([s('loop', 'loop')]).map((n) => n.session.id)).toEqual(['loop']);
  });
});
