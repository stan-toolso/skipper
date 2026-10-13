import { beforeEach, describe, expect, it, vi } from 'vitest';

// Suppression d'un worktree sans perdre l'historique : services simulés, on vérifie ce qui est archivé, arrêté,
// supprimé, et dans quel ordre (rien n'est touché si la suppression est refusée).
const calls = vi.hoisted(() => ({ log: [] as string[] }));
const state = vi.hoisted(() => ({
  worktree: { id: 'w1', projectId: 'p', name: 'secu-oauth', branch: 'secu/oauth', label: null as string | null, archivedAt: null },
  sessions: [] as { id: string; worktreeId: string | null; status: string; archivedAt: Date | null }[],
  terminals: [{ id: 't1', worktreeId: 'w1' }, { id: 't2', worktreeId: 'other' }],
}));
const worktreeService = vi.hoisted(() => ({
  get: vi.fn(async () => ({ ...state.worktree })),
  delete: vi.fn(async (id: string, deleteBranch: boolean) => {
    calls.log.push(`worktree.delete ${id} branch=${deleteBranch}`);
    return true;
  }),
  listByProject: vi.fn(async () => []),
}));
const sessionService = vi.hoisted(() => ({
  list: vi.fn(async (filter: { worktreeId?: string; archived?: string }) => state.sessions.filter((s) => s.worktreeId === filter.worktreeId && (filter.archived === 'all' || !s.archivedAt))),
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
  detachWorktree: vi.fn(async (worktreeId: string, at: Date, former: { name: string; branch: string; label: string }) => {
    calls.log.push(`sessions.detach ${worktreeId} ${former.label}`);
    const ids: string[] = [];
    for (const s of state.sessions) {
      if (s.worktreeId !== worktreeId) continue;
      s.worktreeId = null;
      s.archivedAt ??= at;
      ids.push(s.id);
    }
    return ids;
  }),
  archiveByWorktree: vi.fn(),
  unarchiveByWorktree: vi.fn(),
}));
const terminalService = vi.hoisted(() => ({
  listByProject: vi.fn(async () => state.terminals),
  delete: vi.fn(async (id: string) => {
    calls.log.push(`terminal.delete ${id}`);
    return true;
  }),
}));

vi.mock('../config.js', () => ({ config: { workspacesRoot: '/tmp/ws' } }));
vi.mock('../context/skills.js', () => ({ contextPluginDir: () => '/tmp/plugin' }));
vi.mock('../runners/index.js', () => ({ runner: { remove: vi.fn() } }));
vi.mock('../sessions/repository.js', () => ({ sessionRepository }));
vi.mock('../sessions/service.js', () => ({ sessionService }));
vi.mock('../terminals/service.js', () => ({ terminalService }));
vi.mock('../worktrees/service.js', () => ({ worktreeService, worktreesRoot: () => '/tmp/ws/p.worktrees' }));
vi.mock('./service.js', () => ({ projectService: { get: vi.fn(), delete: vi.fn() } }));
vi.mock('./workspace.js', () => ({ workspacePath: () => '/tmp/ws/p' }));

const { deleteWorktreeCascade, removeWorktreeKeepingSessions } = await import('./cleanup.js');

beforeEach(() => {
  calls.log = [];
  state.sessions = [
    { id: 's-done', worktreeId: 'w1', status: 'completed', archivedAt: null },
    { id: 's-old', worktreeId: 'w1', status: 'completed', archivedAt: new Date('2026-10-01T00:00:00Z') },
    { id: 's-elsewhere', worktreeId: 'other', status: 'completed', archivedAt: null },
  ];
  vi.clearAllMocks();
});

describe('removeWorktreeKeepingSessions', () => {
  it('archive les sessions avec le souvenir du worktree, ferme ses terminaux, puis supprime le worktree', async () => {
    const { archivedSessionIds } = await removeWorktreeKeepingSessions('w1', { deleteBranch: true });
    expect(archivedSessionIds).toEqual(['s-done', 's-old']);
    expect(calls.log).toEqual(['sessions.detach w1 secu/oauth', 'terminal.delete t1', 'worktree.delete w1 branch=true']);
    expect(sessionService.delete).not.toHaveBeenCalled();
    const done = state.sessions.find((s) => s.id === 's-done')!;
    expect(done.worktreeId).toBeNull();
    expect(done.archivedAt).toBeInstanceOf(Date);
    // Une session déjà archivée garde sa date d'archivage.
    expect(state.sessions.find((s) => s.id === 's-old')!.archivedAt).toEqual(new Date('2026-10-01T00:00:00Z'));
    // Les sessions d'un autre worktree ne sont pas touchées.
    expect(state.sessions.find((s) => s.id === 's-elsewhere')).toMatchObject({ worktreeId: 'other', archivedAt: null });
  });

  it('utilise le libellé choisi du worktree quand il en a un', async () => {
    state.worktree.label = 'Jetons OAuth';
    await removeWorktreeKeepingSessions('w1');
    state.worktree.label = null;
    expect(sessionRepository.detachWorktree).toHaveBeenCalledWith('w1', expect.any(Date), { name: 'secu-oauth', branch: 'secu/oauth', label: 'Jetons OAuth' });
  });

  it('refuse, sans rien toucher, si une session tourne encore et que l’arrêt n’est pas demandé', async () => {
    state.sessions.push({ id: 's-live', worktreeId: 'w1', status: 'running', archivedAt: null });
    await expect(removeWorktreeKeepingSessions('w1')).rejects.toThrow(/tournent encore/);
    expect(calls.log).toEqual([]);
  });

  it('arrête les sessions qui tournent quand on le demande, puis archive tout', async () => {
    state.sessions.push({ id: 's-live', worktreeId: 'w1', status: 'queued', archivedAt: null });
    const { archivedSessionIds } = await removeWorktreeKeepingSessions('w1', { stopSessions: true });
    expect(calls.log[0]).toBe('session.stop s-live');
    expect(archivedSessionIds).toEqual(['s-done', 's-old', 's-live']);
  });
});

describe('deleteWorktreeCascade', () => {
  it('archive par défaut (sessions arrêtées si besoin), comme l’interface le promet', async () => {
    state.sessions.push({ id: 's-live', worktreeId: 'w1', status: 'running', archivedAt: null });
    expect(await deleteWorktreeCascade('w1')).toBe(true);
    expect(calls.log).toEqual(['session.stop s-live', 'sessions.detach w1 secu/oauth', 'terminal.delete t1', 'worktree.delete w1 branch=false']);
    expect(sessionService.delete).not.toHaveBeenCalled();
  });

  it('ne supprime les sessions (non archivées) que sur demande explicite', async () => {
    expect(await deleteWorktreeCascade('w1', true, { deleteSessions: true })).toBe(true);
    expect(calls.log).toEqual(['session.delete s-done', 'terminal.delete t1', 'worktree.delete w1 branch=true']);
    expect(sessionRepository.detachWorktree).not.toHaveBeenCalled();
    expect(state.sessions.map((s) => s.id)).toEqual(['s-old', 's-elsewhere']);
  });
});
