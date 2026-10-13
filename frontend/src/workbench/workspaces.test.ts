import { describe, expect, it } from 'vitest';
import { sessionGroups, sessionTree, subagentsSummary } from './workspaces';

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

describe('sessionGroups', () => {
  it('regroupe chaque session de premier niveau avec ses descendants', () => {
    const groups = sessionGroups([s('p'), s('c1', 'p'), s('cc', 'c1'), s('x'), s('orphan', 'elsewhere')]);
    expect(groups.map((g) => [g.root.session.id, g.children.map((c) => c.session.id)])).toEqual([
      ['p', ['c1', 'cc']],
      ['x', []],
      ['orphan', []],
    ]);
    expect(groups[2].root.byAgent).toBe(true);
  });
});

describe('subagentsSummary', () => {
  const child = (status: string, activity: string | null = null, pendingRequestCount = 0) => ({ status, activity, pendingRequestCount }) as Parameters<typeof subagentsSummary>[0][number];
  it('résume le lot : libellé, état dominant, demandes en attente, phrase', () => {
    expect(subagentsSummary([child('RUNNING', 'BUSY'), child('COMPLETED')])).toEqual({ label: '2 sous-agents', state: 'busy', pending: 0, hint: '1 au travail' });
    expect(subagentsSummary([child('RUNNING', 'IDLE', 2)])).toEqual({ label: '1 sous-agent', state: 'ask', pending: 2, hint: null });
    expect(subagentsSummary([child('COMPLETED'), child('FAILED')])).toEqual({ label: '2 sous-agents', state: null, pending: 0, hint: 'terminés' });
    expect(subagentsSummary([child('QUEUED')])).toEqual({ label: '1 sous-agent', state: 'idle', pending: 0, hint: "en file d'attente" });
    expect(subagentsSummary([child('RUNNING', 'IDLE'), child('RUNNING', 'IDLE'), child('QUEUED')])).toEqual({ label: '3 sous-agents', state: 'idle', pending: 0, hint: '2 en attente' });
  });
});
