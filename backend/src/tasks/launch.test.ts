import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionProvider } from '../sessions/providers/provider.js';

// Mode d'autorisation par défaut du projet : appliqué aux sessions de tâches (et à toute session créée sans mode),
// sans écraser un mode choisi explicitement. Dépôts et services voisins simulés, sans base.
const state = vi.hoisted(() => ({ created: [] as Record<string, unknown>[], projectMode: 'acceptEdits', taskWorksession: null as Record<string, unknown> | null, active: [] as { id: string; name: string; worksessionId: string }[] }));
const repo = vi.hoisted(() => ({
  // Sessions actives d'une work session (règle « une seule session active par work session »).
  list: vi.fn(async (filter: { worksessionId?: string }) => state.active.filter((s) => s.worksessionId === filter.worksessionId)),
  create: vi.fn(async (input: Record<string, unknown>) => {
    state.created.push(input);
    return { id: `s${state.created.length}`, projectId: 'p', name: input.name, provider: input.provider, status: 'pending', prompt: input.prompt, promptAttachments: [], config: input.config ?? {} };
  }),
}));
const tasks = vi.hoisted(() => ({
  get: vi.fn(async () => ({ id: 't1', projectId: 'p', title: 'Tâche', description: '', status: 'todo', sessionIds: ['s-prev'] })),
  update: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ id: 't1', projectId: 'p', title: 'Tâche', description: '', ...patch })),
  describeForPrompt: vi.fn(() => 'Réalise la tâche'),
  comments: vi.fn(async () => []),
  attachments: vi.fn(async () => []),
}));

vi.mock('../sessions/repository.js', () => ({ sessionRepository: repo }));
vi.mock('../tasks/service.js', () => ({ taskService: tasks }));
vi.mock('../projects/service.js', () => ({
  projectService: { get: async () => ({ id: 'p', name: 'Projet', gitUrl: null, defaultPermissionMode: state.projectMode }) },
  slugify: (s: string) => s,
}));
vi.mock('../worksessions/service.js', () => ({
  worksessionService: {
    resolveCwd: async () => '/tmp',
    assertUsable: async (_p: unknown, id: string) => ({ id, branch: 'task/x' }),
    forTask: async () => state.taskWorksession,
    create: vi.fn(async (_p: string, input: Record<string, unknown>) => ({ id: 'w-new', name: input.name, branch: input.branch, label: input.label, taskId: input.taskId })),
  },
}));
vi.mock('../worksessions/repository.js', () => ({ worksessionRepository: { listByProject: async () => [] } }));
vi.mock('../requests/service.js', () => ({ requestService: {} }));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: vi.fn() } }));
vi.mock('../settings/repository.js', () => ({ settingsRepository: { get: vi.fn(async () => null), set: vi.fn() } }));
vi.mock('../pubsub.js', () => ({ pubSub: { publish: vi.fn() } }));
vi.mock('../sessions/providers/registry.js', () => ({
  getProvider: (): SessionProvider => ({
    type: 'claude',
    describe: () => ({ type: 'claude', label: 'Claude', description: '', interactive: true, configFields: [{ key: 'permissionMode', label: 'Autorisations', type: 'select', required: false }] }),
    start: vi.fn(),
  }),
}));

const { sessionService } = await import('../sessions/service.js');
const { startTaskSession, taskWorksessionNames } = await import('./launch.js');

beforeEach(() => {
  state.created = [];
  state.projectMode = 'acceptEdits';
  state.taskWorksession = null;
  state.active = [];
  vi.spyOn(sessionService, 'start').mockImplementation(async (id: string) => ({ id }) as never);
  vi.spyOn(sessionService, 'archive').mockImplementation(async (id: string) => {
    state.active = state.active.filter((s) => s.id !== id);
    return { id } as never;
  });
});

describe("mode d'autorisation par défaut du projet", () => {
  it("lance les sessions de tâche dans le mode du projet", async () => {
    await startTaskSession('t1');
    expect(state.created[0].config).toEqual({ permissionMode: 'acceptEdits' });
  });

  it('ne remplace pas un mode choisi explicitement', async () => {
    await startTaskSession('t1', { config: { permissionMode: 'plan' } });
    expect(state.created[0].config).toEqual({ permissionMode: 'plan' });
  });

  it('applique le mode du projet à une session créée sans mode', async () => {
    state.projectMode = 'bypassPermissions';
    await sessionService.create({ projectId: 'p', worksessionId: 'w1', name: 'x', provider: 'claude', prompt: null, config: { model: 'opus' }, autoStart: false });
    expect(state.created[0].config).toEqual({ model: 'opus', permissionMode: 'bypassPermissions' });
  });
});

describe('work session de la tâche', () => {
  it('crée la work session de la tâche à sa première session, nommée d’après son titre', async () => {
    tasks.get.mockResolvedValueOnce({ id: 't1', projectId: 'p', title: 'Export CSV des factures', description: '', status: 'todo', sessionIds: [] });
    await startTaskSession('t1');
    expect(state.created[0].worksessionId).toBe('w-new');
  });

  it('ramène un titre trop long à la longueur admise pour le libellé de la work session', async () => {
    const title = `Corriger ${'un bug très long à décrire '.repeat(8)}dans le lancement`;
    expect(title.length).toBeGreaterThan(100);
    const names = taskWorksessionNames({ title }, []);
    expect(names.label.length).toBeLessThanOrEqual(100);
    expect(names.label.startsWith('Corriger un bug')).toBe(true);
    expect(names.branch).toMatch(/^task\/corriger-un-bug/);
    tasks.get.mockResolvedValueOnce({ id: 't1', projectId: 'p', title, description: '', status: 'todo', sessionIds: [] });
    await startTaskSession('t1');
    const { worksessionService } = await import('../worksessions/service.js');
    const input = (worksessionService.create as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as { label: string };
    expect(input.label.length).toBeLessThanOrEqual(100);
    expect(state.created[0].worksessionId).toBe('w-new');
  });

  it('réutilise la work session existante de la tâche', async () => {
    state.taskWorksession = { id: 'w-task', name: 'task-export', branch: 'task/export' };
    await startTaskSession('t1');
    expect(state.created[0].worksessionId).toBe('w-task');
  });

  it('archive la session précédente de la tâche : la nouvelle reprend seule le dossier et la branche', async () => {
    state.taskWorksession = { id: 'w-task', name: 'task-export', branch: 'task/export' };
    state.active = [{ id: 's-prev', name: 'Tâche', worksessionId: 'w-task' }];
    await startTaskSession('t1');
    expect(sessionService.archive).toHaveBeenCalledWith('s-prev');
    expect(state.created[0].worksessionId).toBe('w-task');
  });

  it('refuse une session dans une work session où une autre session travaille déjà', async () => {
    state.active = [{ id: 's-prev', name: 'Première', worksessionId: 'w-busy' }];
    await expect(sessionService.create({ projectId: 'p', worksessionId: 'w-busy', name: 'x', provider: 'claude', prompt: null, config: {}, autoStart: false })).rejects.toThrow(/« Première » travaille déjà/);
  });

  it('refuse une session sans work session', async () => {
    await expect(sessionService.create({ projectId: 'p', name: 'x', provider: 'claude', prompt: null, config: {}, autoStart: false })).rejects.toThrow(/work session/);
  });
});
