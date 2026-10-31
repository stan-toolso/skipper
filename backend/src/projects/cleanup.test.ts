import { beforeEach, describe, expect, it, vi } from 'vitest';

// Suppression d'une work session sans perdre l'historique : services simulés, on vérifie ce qui est archivé, arrêté,
// supprimé, et dans quel ordre (rien n'est touché si la suppression est refusée).
const calls = vi.hoisted(() => ({ log: [] as string[] }));
const state = vi.hoisted(() => ({
  worksession: { id: 'w1', projectId: 'p', name: 'secu-oauth', branch: 'secu/oauth', label: null as string | null, archivedAt: null },
  sessions: [] as { id: string; worksessionId: string | null; status: string; archivedAt: Date | null }[],
  terminals: [{ id: 't1', worksessionId: 'w1' }, { id: 't2', worksessionId: 'other' }],
}));
const worksessionService = vi.hoisted(() => ({
  get: vi.fn(async () => ({ ...state.worksession })),
  delete: vi.fn(async (id: string, deleteBranch: boolean) => {
    calls.log.push(`worksession.delete ${id} branch=${deleteBranch}`);
    return true;
  }),
  listByProject: vi.fn(async () => []),
  archive: vi.fn(async (id: string, archiveSessions: (worksessionId: string, at: Date) => Promise<void>) => {
    calls.log.push(`worksession.archive ${id}`);
    await archiveSessions(id, new Date());
    return { ...state.worksession, archivedAt: new Date() };
  }),
}));
const sessionService = vi.hoisted(() => ({
  get: vi.fn(async (id: string) => state.sessions.find((s) => s.id === id) ?? null),
  archive: vi.fn(async (id: string) => {
    calls.log.push(`session.archive ${id}`);
    const s = state.sessions.find((x) => x.id === id)!;
    s.archivedAt = new Date();
    return s;
  }),
  list: vi.fn(async (filter: { worksessionId?: string; archived?: string }) => state.sessions.filter((s) => s.worksessionId === filter.worksessionId && (filter.archived === 'all' || !s.archivedAt))),
  stop: vi.fn(async (id: string) => {
    calls.log.push(`session.stop ${id}`);
    const s = state.sessions.find((x) => x.id === id)!;
    s.status = 'stopped';
    return s;
  }),
  delete: vi.fn(async (id: string) => {
    calls.log.push(`session.delete ${id}`);
    state.sessions = state.sessions.filter((s) => s.id !== id);
    return true;
  }),
}));
const sessionRepository = vi.hoisted(() => ({
  detachWorksession: vi.fn(async (worksessionId: string, at: Date, former: { name: string; branch: string; label: string }) => {
    calls.log.push(`sessions.detach ${worksessionId} ${former.label}`);
    const ids: string[] = [];
    for (const s of state.sessions) {
      if (s.worksessionId !== worksessionId) continue;
      s.worksessionId = null;
      s.archivedAt ??= at;
      ids.push(s.id);
    }
    return ids;
  }),
  archiveByWorksession: vi.fn(),
  unarchiveByWorksession: vi.fn(),
}));
const terminalService = vi.hoisted(() => ({
  listByProject: vi.fn(async () => state.terminals),
  delete: vi.fn(async (id: string) => {
    calls.log.push(`terminal.delete ${id}`);
    return true;
  }),
}));

const project = vi.hoisted(() => ({ running: 0, value: { id: 'p', slug: 'p', gitHosted: true } }));
const gitServer = vi.hoisted(() => ({
  retire: vi.fn(async (_p: unknown, opts: { delete: boolean }) => {
    calls.log.push(`git.retire delete=${opts.delete}`);
    return null;
  }),
}));

vi.mock('../config.js', () => ({ config: { workspacesRoot: '/tmp/ws' } }));
vi.mock('../gitServer/service.js', () => ({ gitServer }));
vi.mock('./repository.js', () => ({ projectRepository: { countRunningSessions: vi.fn(async () => project.running) } }));
vi.mock('../context/skills.js', () => ({ contextPluginDir: () => '/tmp/plugin' }));
vi.mock('../runners/index.js', () => ({ runner: { remove: vi.fn(async () => undefined) } }));
vi.mock('../sessions/repository.js', () => ({ sessionRepository }));
vi.mock('../sessions/service.js', () => ({ sessionService }));
vi.mock('../terminals/service.js', () => ({ terminalService }));
vi.mock('../worksessions/service.js', () => ({ worksessionService, worksessionsRoot: () => '/tmp/ws/p.worktrees' }));
vi.mock('./service.js', () => ({
  projectService: {
    get: vi.fn(async () => project.value),
    delete: vi.fn(async () => {
      calls.log.push('project.delete');
      return true;
    }),
  },
}));
vi.mock('./workspace.js', () => ({ workspacePath: () => '/tmp/ws/p' }));

const { archiveSessionCascade, deleteProjectCascade, deleteSessionCascade, deleteWorksessionCascade, removeWorksessionKeepingSessions } = await import('./cleanup.js');

beforeEach(() => {
  calls.log = [];
  state.sessions = [
    { id: 's-done', worksessionId: 'w1', status: 'completed', archivedAt: null },
    { id: 's-old', worksessionId: 'w1', status: 'completed', archivedAt: new Date('2026-10-01T00:00:00Z') },
    { id: 's-elsewhere', worksessionId: 'other', status: 'completed', archivedAt: null },
  ];
  vi.clearAllMocks();
});

describe('removeWorksessionKeepingSessions', () => {
  it('archive les sessions avec le souvenir de la work session, ferme ses terminaux, puis supprime la work session', async () => {
    const { archivedSessionIds } = await removeWorksessionKeepingSessions('w1', { deleteBranch: true });
    expect(archivedSessionIds).toEqual(['s-done', 's-old']);
    expect(calls.log).toEqual(['sessions.detach w1 secu/oauth', 'terminal.delete t1', 'worksession.delete w1 branch=true']);
    expect(sessionService.delete).not.toHaveBeenCalled();
    const done = state.sessions.find((s) => s.id === 's-done')!;
    expect(done.worksessionId).toBeNull();
    expect(done.archivedAt).toBeInstanceOf(Date);
    // Une session déjà archivée garde sa date d'archivage.
    expect(state.sessions.find((s) => s.id === 's-old')!.archivedAt).toEqual(new Date('2026-10-01T00:00:00Z'));
    // Les sessions d'un autre work session ne sont pas touchées.
    expect(state.sessions.find((s) => s.id === 's-elsewhere')).toMatchObject({ worksessionId: 'other', archivedAt: null });
  });

  it('utilise le libellé choisi de la work session quand elle en a un', async () => {
    state.worksession.label = 'Jetons OAuth';
    await removeWorksessionKeepingSessions('w1');
    state.worksession.label = null;
    expect(sessionRepository.detachWorksession).toHaveBeenCalledWith('w1', expect.any(Date), { name: 'secu-oauth', branch: 'secu/oauth', label: 'Jetons OAuth' });
  });

  it('refuse, sans rien toucher, si une session tourne encore et que l’arrêt n’est pas demandé', async () => {
    state.sessions.push({ id: 's-live', worksessionId: 'w1', status: 'running', archivedAt: null });
    await expect(removeWorksessionKeepingSessions('w1')).rejects.toThrow(/tournent encore/);
    expect(calls.log).toEqual([]);
  });

  it('arrête les sessions qui tournent quand on le demande, puis archive tout', async () => {
    state.sessions.push({ id: 's-live', worksessionId: 'w1', status: 'queued', archivedAt: null });
    const { archivedSessionIds } = await removeWorksessionKeepingSessions('w1', { stopSessions: true });
    expect(calls.log[0]).toBe('session.stop s-live');
    expect(archivedSessionIds).toEqual(['s-done', 's-old', 's-live']);
  });
});

describe('archiveSessionCascade', () => {
  it('archive la session puis sa work session (terminaux fermés) quand aucune autre session active n’y reste', async () => {
    await archiveSessionCascade('s-done');
    expect(calls.log).toEqual(['session.archive s-done', 'worksession.archive w1', 'terminal.delete t1']);
    expect(sessionRepository.archiveByWorksession).toHaveBeenCalledWith('w1', expect.any(Date));
  });

  it('laisse la work session active tant qu’une autre session y travaille (données d’avant la règle « une session par work session »)', async () => {
    state.sessions.push({ id: 's-live', worksessionId: 'w1', status: 'running', archivedAt: null });
    await archiveSessionCascade('s-done');
    expect(calls.log).toEqual(['session.archive s-done']);
  });

  it('archive simplement une session sans work session', async () => {
    state.sessions.push({ id: 's-main', worksessionId: null, status: 'completed', archivedAt: null });
    await archiveSessionCascade('s-main');
    expect(calls.log).toEqual(['session.archive s-main']);
  });
});

describe('deleteSessionCascade', () => {
  it('supprime la work session (terminaux fermés, branche gardée sauf demande) quand il ne lui reste aucune session', async () => {
    state.sessions = state.sessions.filter((s) => s.id !== 's-old');
    expect(await deleteSessionCascade('s-done', true)).toBe(true);
    expect(calls.log).toEqual(['session.delete s-done', 'terminal.delete t1', 'worksession.delete w1 branch=true']);
  });

  it('archive la work session quand il n’y reste que des sessions archivées', async () => {
    expect(await deleteSessionCascade('s-done')).toBe(true);
    expect(calls.log).toEqual(['session.delete s-done', 'worksession.archive w1', 'terminal.delete t1']);
    expect(worksessionService.delete).not.toHaveBeenCalled();
  });

  it('ne touche pas à une work session où une autre session travaille encore', async () => {
    state.sessions.push({ id: 's-live', worksessionId: 'w1', status: 'running', archivedAt: null });
    await deleteSessionCascade('s-done');
    expect(calls.log).toEqual(['session.delete s-done']);
  });
});

describe('deleteWorksessionCascade', () => {
  it('archive par défaut (sessions arrêtées si besoin), comme l’interface le promet', async () => {
    state.sessions.push({ id: 's-live', worksessionId: 'w1', status: 'running', archivedAt: null });
    expect(await deleteWorksessionCascade('w1')).toBe(true);
    expect(calls.log).toEqual(['session.stop s-live', 'sessions.detach w1 secu/oauth', 'terminal.delete t1', 'worksession.delete w1 branch=false']);
    expect(sessionService.delete).not.toHaveBeenCalled();
  });

  it('ne supprime les sessions (non archivées) que sur demande explicite', async () => {
    expect(await deleteWorksessionCascade('w1', true, { deleteSessions: true })).toBe(true);
    expect(calls.log).toEqual(['session.delete s-done', 'terminal.delete t1', 'worksession.delete w1 branch=true']);
    expect(sessionRepository.detachWorksession).not.toHaveBeenCalled();
    expect(state.sessions.map((s) => s.id)).toEqual(['s-old', 's-elsewhere']);
  });
});

describe('deleteProjectCascade', () => {
  it("traite le dépôt hébergé d'abord, avec l'option choisie, puis supprime le projet", async () => {
    project.running = 0;
    state.sessions = [];
    await deleteProjectCascade('p', { deleteHostedRepo: true });
    expect(calls.log[0]).toBe('git.retire delete=true');
    expect(calls.log.at(-1)).toBe('project.delete');
    calls.log = [];
    await deleteProjectCascade('p');
    expect(calls.log[0]).toBe('git.retire delete=false');
  });

  it('ne touche à rien, dépôt compris, tant que des sessions tournent', async () => {
    project.running = 1;
    await expect(deleteProjectCascade('p', { deleteHostedRepo: true })).rejects.toThrow(/sessions en cours/);
    expect(calls.log).toEqual([]);
    project.running = 0;
  });
});
