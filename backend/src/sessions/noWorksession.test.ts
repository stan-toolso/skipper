import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionProvider } from './providers/provider.js';

// Session dont le dossier de travail (work session) a été supprimé, à la fusion de sa PR par exemple : la clé
// étrangère a remis `worksession_id` à NULL. Elle ne doit jamais repartir dans le checkout principal du projet.
const store = vi.hoisted(() => ({ sessions: new Map<string, Record<string, unknown>>() }));
const repo = vi.hoisted(() => ({
  findById: vi.fn(async (id: string) => (store.sessions.has(id) ? { ...store.sessions.get(id) } : null)),
  update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const s = store.sessions.get(id)!;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) s[k] = v;
    return { ...s };
  }),
  list: vi.fn(async () => []),
  addEvent: vi.fn(async (sessionId: string, type: string, payload: Record<string, unknown>) => ({ id: '1', sessionId, type, payload, createdAt: new Date() })),
  listQueued: vi.fn(async () => []),
  queuePosition: vi.fn(async () => null),
}));
const worksessions = vi.hoisted(() => ({
  resolveCwd: vi.fn(async () => '/checkout-principal'),
  assertUsable: vi.fn(async () => ({})),
  restore: vi.fn(async () => undefined),
}));
const provider = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock('./repository.js', () => ({ sessionRepository: repo }));
vi.mock('../requests/service.js', () => ({ requestService: { cancelAllForSession: vi.fn(async () => undefined), ask: vi.fn() } }));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: vi.fn(async () => undefined) } }));
vi.mock('../settings/repository.js', () => ({ settingsRepository: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) } }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, name: id, runnerConfig: {} }) } }));
vi.mock('../worksessions/service.js', () => ({ worksessionService: worksessions }));
vi.mock('../pubsub.js', () => ({ pubSub: { publish: vi.fn(), subscribe: () => ({ next: () => new Promise(() => undefined), return: async () => ({ done: true, value: undefined }) }) } }));
vi.mock('./providers/registry.js', () => ({ getProvider: () => ({ type: 'fake', start: provider.start }) as unknown as SessionProvider }));

const base = { projectId: 'p', kind: 'session', provider: 'fake', name: 'tâche', prompt: 'fais', promptAttachments: [], config: {}, cleanup: {}, externalId: 'conv-1', status: 'completed', activity: null, archivedAt: null, queuedAt: null, parkedAt: null, ownerId: null };

beforeEach(() => {
  store.sessions.clear();
  vi.clearAllMocks();
});

describe('session dont le dossier de travail a été supprimé', () => {
  it('sendMessage refuse au lieu de démarrer dans le checkout principal', async () => {
    store.sessions.set('s1', { ...base, id: 's1', worksessionId: null, formerWorksession: { name: 'task-x', branch: 'task/x', label: 'x' } });
    const { sessionService } = await import('./service.js');
    await expect(sessionService.sendMessage('s1', 'continue')).rejects.toMatchObject({ code: 'NO_WORKSESSION', message: expect.stringContaining('task/x') });
    expect(worksessions.resolveCwd).not.toHaveBeenCalled();
    expect(provider.start).not.toHaveBeenCalled();
    expect(store.sessions.get('s1')!.status).toBe('completed');
  });

  it('start refuse aussi une session sans dossier, même sans souvenir de sa work session', async () => {
    store.sessions.set('s2', { ...base, id: 's2', worksessionId: null, formerWorksession: null });
    const { sessionService } = await import('./service.js');
    await expect(sessionService.start('s2', 'reprends')).rejects.toMatchObject({ code: 'NO_WORKSESSION' });
    expect(provider.start).not.toHaveBeenCalled();
  });

  it('une session archivée dont le dossier a été supprimé ne se restaure pas', async () => {
    store.sessions.set('s3', { ...base, id: 's3', worksessionId: null, archivedAt: new Date(), formerWorksession: { name: 'task-x', branch: 'task/x', label: 'x' } });
    const { sessionService } = await import('./service.js');
    await expect(sessionService.unarchive('s3')).rejects.toMatchObject({ code: 'NO_WORKSESSION' });
    expect(store.sessions.get('s3')!.archivedAt).toBeInstanceOf(Date);
  });

  it("un chat, qui n'a jamais de dossier, n'est pas concerné", async () => {
    store.sessions.set('c1', { ...base, id: 'c1', kind: 'chat', worksessionId: null, formerWorksession: null, archivedAt: new Date() });
    const { sessionService } = await import('./service.js');
    await expect(sessionService.unarchive('c1')).resolves.toMatchObject({ archivedAt: null });
  });
});

describe('message envoyé à une session archivée', () => {
  it("refusé sans l'option unarchive (agents, fils)", async () => {
    store.sessions.set('a1', { ...base, id: 'a1', worksessionId: 'w1', archivedAt: new Date() });
    const { sessionService } = await import('./service.js');
    await expect(sessionService.sendMessage('a1', 'continue')).rejects.toMatchObject({ code: 'ARCHIVED' });
    expect(store.sessions.get('a1')!.archivedAt).toBeInstanceOf(Date);
  });

  it('une personne la restaure avec son dossier puis la relance avec son message', async () => {
    store.sessions.set('a2', { ...base, id: 'a2', worksessionId: 'w2', archivedAt: new Date() });
    const { sessionService } = await import('./service.js');
    const start = vi.spyOn(sessionService, 'start').mockImplementation(async (id: string) => ({ id }) as never);
    await sessionService.sendMessage('a2', 'reprends', null, { byPerson: true, unarchive: true });
    expect(store.sessions.get('a2')!.archivedAt).toBeNull();
    expect(worksessions.restore).toHaveBeenCalledWith('w2');
    expect(repo.addEvent).toHaveBeenCalledWith('a2', 'system', expect.objectContaining({ reason: 'unarchived_by_message' }));
    expect(start).toHaveBeenCalledWith('a2', 'reprends', [], expect.anything());
    start.mockRestore();
  });

  it("transmis à la session qui travaille désormais dans son dossier (agent reconvoqué sur la tâche)", async () => {
    store.sessions.set('a4', { ...base, id: 'a4', name: 'ancienne', worksessionId: 'w4', archivedAt: new Date() });
    store.sessions.set('a5', { ...base, id: 'a5', name: 'nouvelle', worksessionId: 'w4' });
    repo.list.mockImplementationOnce((async () => [{ ...store.sessions.get('a5') }]) as never);
    const { sessionService } = await import('./service.js');
    const start = vi.spyOn(sessionService, 'start').mockImplementation(async (id: string) => ({ id }) as never);
    const result = await sessionService.sendMessage('a4', 'Met en prod la 470 aussi', null, { byPerson: true, unarchive: true });
    expect(result).toMatchObject({ id: 'a5' });
    expect(store.sessions.get('a4')!.archivedAt).toBeInstanceOf(Date);
    expect(worksessions.restore).not.toHaveBeenCalled();
    expect(repo.addEvent).toHaveBeenCalledWith('a4', 'system', expect.objectContaining({ reason: 'forwarded_to_successor', sessionId: 'a5' }));
    expect(start).toHaveBeenCalledWith('a5', expect.stringMatching(/session archivée « ancienne » \(a4\)[\s\S]*Met en prod la 470 aussi$/), [], expect.anything());
    start.mockRestore();
  });

  it('reste archivée si son dossier a été supprimé', async () => {
    store.sessions.set('a3', { ...base, id: 'a3', worksessionId: null, archivedAt: new Date(), formerWorksession: { name: 'task-x', branch: 'task/x', label: 'x' } });
    const { sessionService } = await import('./service.js');
    await expect(sessionService.sendMessage('a3', 'reprends', null, { unarchive: true })).rejects.toMatchObject({ code: 'NO_WORKSESSION' });
    expect(store.sessions.get('a3')!.archivedAt).toBeInstanceOf(Date);
  });
});
