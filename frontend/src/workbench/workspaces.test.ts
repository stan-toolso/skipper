import { describe, expect, it } from 'vitest';
import { WorkspaceIndex, attachedElsewhere, sessionGroups, sessionTree, subagentsSummary } from './workspaces';

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

  it('cherche les descendants dans le pool du projet : un sous-agent d’un autre dossier se range sous sa parente', () => {
    const pool = [s('p'), s('c-here', 'p'), s('c-there', 'p'), s('gc-there', 'c-there'), s('x')];
    const here = sessionGroups([s('p'), s('c-here', 'p'), s('x')], pool);
    expect(here.map((g) => [g.root.session.id, g.children.map((c) => [c.session.id, c.depth])])).toEqual([
      ['p', [['c-here', 1], ['c-there', 1], ['gc-there', 2]]],
      ['x', []],
    ]);
    // Dans l'autre dossier, c-there est de premier niveau, marquée sous-agent de « p », avec son propre descendant.
    const there = sessionGroups([s('c-there', 'p'), s('gc-there', 'c-there')], pool);
    expect(there).toHaveLength(1);
    expect(there[0].root.byAgent).toBe(true);
    expect(there[0].root.parentName).toBe('Session p');
    expect(there[0].children.map((c) => [c.session.id, c.depth])).toEqual([['gc-there', 1]]);
  });
});

describe('attachedElsewhere', () => {
  const pool = new Map([s('p'), s('c-here', 'p'), s('c-there', 'p'), s('gc-there', 'c-there'), s('orphan', 'gone')].map((x) => [x.id, x]));
  it('cache dans un dossier les sous-agents dont la parente ou une aïeule est dans un autre dossier du projet', () => {
    const there = new Set(['c-there', 'gc-there']);
    expect(attachedElsewhere(s('c-there', 'p'), there, pool)).toBe(true);
    expect(attachedElsewhere(s('gc-there', 'c-there'), there, pool)).toBe(true); // parente ici, mais aïeule ailleurs
    const home = new Set(['p', 'c-here']);
    expect(attachedElsewhere(s('c-here', 'p'), home, pool)).toBe(false);
    expect(attachedElsewhere(s('p'), home, pool)).toBe(false);
    expect(attachedElsewhere(s('orphan', 'gone'), new Set(['orphan']), pool)).toBe(false); // parente inconnue : reste visible, avec son robot
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

describe('WorkspaceIndex', () => {
  const session = (id: string, worksession: { id: string; branch: string } | null, parent: string | null = null) => ({
    id,
    name: `Session ${id}`,
    status: 'RUNNING' as const,
    activity: null,
    pendingRequestCount: 0,
    browserActive: false,
    context: { tokens: null, overThreshold: false },
    owner: null,
    parentSession: parent ? { id: parent } : null,
    worksession: worksession ? { ...worksession, name: worksession.branch, exists: true, task: null } : null,
  });
  const project = (sessions: ReturnType<typeof session>[], terminals: { id: string; name: string; status: 'RUNNING'; worksession: { id: string } | null }[] = []) => ({
    id: 'p',
    name: 'Projet',
    slug: 'projet',
    gitUrl: 'git@github.com:x/y.git',
    gitBranch: 'main',
    isMember: true,
    isPersonal: false,
    myRole: 'ADMIN' as const,
    sessions,
    terminals,
  });

  it('fait un dossier par session, clé /sessions/:id, avec la branche et les terminaux de son dossier', () => {
    const index = new WorkspaceIndex([project([session('a', { id: 'w1', branch: 'feat/a' }), session('b', { id: 'w2', branch: 'feat/b' })], [{ id: 't1', name: 'T1', status: 'RUNNING', worksession: { id: 'w2' } }])]);
    const a = index.get('/sessions/a')!;
    expect(a).toMatchObject({ worksessionId: 'w1', name: 'Session a', branch: 'feat/a', primary: false, terminals: [] });
    expect(index.get('/sessions/b')!.terminals.map((t) => t.id)).toEqual(['t1']);
    expect(index.ofProject('p').map((ws) => ws.key)).toEqual(['/projects/p/files', '/sessions/a', '/sessions/b']);
  });

  it('range la session, ses fichiers, son navigateur et ses terminaux dans le même onglet', () => {
    const index = new WorkspaceIndex([project([session('a', { id: 'w1', branch: 'feat/a' })], [{ id: 't1', name: 'T1', status: 'RUNNING', worksession: { id: 'w1' } }])]);
    expect(index.keyOf('/sessions/a')).toBe('/sessions/a');
    expect(index.keyOf('/sessions/a/files/src/index.ts')).toBe('/sessions/a');
    expect(index.keyOf('/sessions/a/browser')).toBe('/sessions/a');
    expect(index.keyOf('/terminals/t1')).toBe('/sessions/a');
    expect(index.keyOf('/sessions/inconnue')).toBeNull();
    expect(index.keyOf('/projects/p/files/README.md')).toBe('/projects/p/files');
  });

  it('garde les sessions et terminaux sans dossier (d’avant les work sessions) dans le checkout principal', () => {
    const index = new WorkspaceIndex([project([session('old', null)], [{ id: 't0', name: 'T0', status: 'RUNNING', worksession: null }])]);
    const primary = index.get('/projects/p/files')!;
    expect(primary.primary).toBe(true);
    expect(primary.sessions.map((s) => s.id)).toEqual(['old']);
    expect(primary.terminals.map((t) => t.id)).toEqual(['t0']);
    expect(index.keyOf('/sessions/old')).toBe('/projects/p/files');
  });

  it('attache les terminaux d’un dossier partagé (données anciennes) à sa première session seulement', () => {
    const index = new WorkspaceIndex([project([session('a', { id: 'w1', branch: 'x' }), session('b', { id: 'w1', branch: 'x' })], [{ id: 't1', name: 'T1', status: 'RUNNING', worksession: { id: 'w1' } }])]);
    expect(index.get('/sessions/a')!.terminals.map((t) => t.id)).toEqual(['t1']);
    expect(index.get('/sessions/b')!.terminals).toEqual([]);
  });
});
