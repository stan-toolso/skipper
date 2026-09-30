import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionProvider } from '../sessions/providers/provider.js';

// Mode d'autorisation par défaut du projet : appliqué aux sessions de tâches (et à toute session créée sans mode),
// sans écraser un mode choisi explicitement. Dépôts et services voisins simulés, sans base.
const state = vi.hoisted(() => ({ created: [] as Record<string, unknown>[], projectMode: 'acceptEdits' }));
const repo = vi.hoisted(() => ({
  create: vi.fn(async (input: Record<string, unknown>) => {
    state.created.push(input);
    return { id: `s${state.created.length}`, projectId: 'p', name: input.name, provider: input.provider, status: 'pending', prompt: input.prompt, promptAttachments: [], config: input.config ?? {} };
  }),
}));
const tasks = vi.hoisted(() => ({
  get: vi.fn(async () => ({ id: 't1', projectId: 'p', title: 'Tâche', description: '', status: 'todo' })),
  update: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ id: 't1', projectId: 'p', title: 'Tâche', description: '', ...patch })),
  describeForPrompt: vi.fn(() => 'Réalise la tâche'),
}));

vi.mock('../sessions/repository.js', () => ({ sessionRepository: repo }));
vi.mock('../tasks/service.js', () => ({ taskService: tasks }));
vi.mock('../projects/service.js', () => ({
  projectService: { get: async () => ({ id: 'p', name: 'Projet', gitUrl: null, defaultPermissionMode: state.projectMode }) },
  slugify: (s: string) => s,
}));
vi.mock('../worktrees/service.js', () => ({ worktreeService: { resolveCwd: async () => '/tmp' } }));
vi.mock('../worktrees/repository.js', () => ({ worktreeRepository: { listByProject: async () => [] } }));
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
const { startTaskSession } = await import('./launch.js');

beforeEach(() => {
  state.created = [];
  state.projectMode = 'acceptEdits';
  vi.spyOn(sessionService, 'start').mockImplementation(async (id: string) => ({ id }) as never);
});

describe("mode d'autorisation par défaut du projet", () => {
  it("lance les sessions de tâche dans le mode du projet", async () => {
    await startTaskSession('t1', { dedicatedWorktree: false });
    expect(state.created[0].config).toEqual({ permissionMode: 'acceptEdits' });
  });

  it('ne remplace pas un mode choisi explicitement', async () => {
    await startTaskSession('t1', { dedicatedWorktree: false, config: { permissionMode: 'plan' } });
    expect(state.created[0].config).toEqual({ permissionMode: 'plan' });
  });

  it('applique le mode du projet à une session créée sans mode', async () => {
    state.projectMode = 'bypassPermissions';
    await sessionService.create({ projectId: 'p', name: 'x', provider: 'claude', prompt: null, config: { model: 'opus' }, autoStart: false });
    expect(state.created[0].config).toEqual({ model: 'opus', permissionMode: 'bypassPermissions' });
  });
});
