import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext, RunResult, SessionProvider } from './providers/provider.js';
import type { Session } from './types.js';

// File d'attente des sessions et arrêt des sessions inactives, sans base ni processus : dépôt en mémoire,
// provider simulé dont on contrôle la fin et l'activité.
const store = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  events: [] as { sessionId: string; type: string; payload: Record<string, unknown> }[],
  seq: 0,
  projects: new Map<string, Record<string, unknown>>(),
}));
const repo = vi.hoisted(() => {
  const queued = () => [...store.sessions.values()].filter((s) => s.status === 'queued').sort((a, b) => (a.queuedAt as Date).getTime() - (b.queuedAt as Date).getTime() || Number(String(a.id).slice(1)) - Number(String(b.id).slice(1)));
  return {
    create: vi.fn(async (input: Record<string, unknown>) => {
      const s = { id: `s${++store.seq}`, projectId: input.projectId, worktreeId: null, parentSessionId: input.parentSessionId ?? null, name: input.name, provider: input.provider, status: 'pending', activity: null, prompt: input.prompt, promptAttachments: [], config: {}, externalId: null, exitCode: null, error: null, queuedAt: null, queuedStart: null };
      store.sessions.set(s.id, s);
      return { ...s };
    }),
    findById: vi.fn(async (id: string) => (store.sessions.has(id) ? { ...store.sessions.get(id) } : null)),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const s = store.sessions.get(id)!;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) s[k] = v;
      return { ...s };
    }),
    list: vi.fn(async () => []),
    addEvent: vi.fn(async (sessionId: string, type: string, payload: Record<string, unknown>) => {
      store.events.push({ sessionId, type, payload });
      return { id: String(store.events.length), sessionId, type, payload, createdAt: new Date() };
    }),
    listQueued: vi.fn(async () => queued().map((s) => ({ ...s }))),
    queuePosition: vi.fn(async (id: string) => {
      const i = queued().findIndex((s) => s.id === id);
      return i < 0 ? null : i + 1;
    }),
  };
});
const notifications = vi.hoisted(() => ({ notify: vi.fn(async () => undefined) }));
const settingsRepo = vi.hoisted(() => ({ get: vi.fn(async () => null), set: vi.fn(async () => undefined) }));
const providers = vi.hoisted(() => ({ current: null as SessionProvider | null }));

vi.mock('./repository.js', () => ({ sessionRepository: repo }));
vi.mock('../requests/service.js', () => ({ requestService: { cancelAllForSession: vi.fn(async () => undefined), ask: vi.fn() } }));
vi.mock('../notifications/service.js', () => ({ notificationService: notifications }));
vi.mock('../settings/repository.js', () => ({ settingsRepository: settingsRepo }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => store.projects.get(id) ?? { id, name: id, runnerConfig: {} } } }));
vi.mock('../worktrees/service.js', () => ({ worktreeService: { resolveCwd: async () => '/tmp' } }));
vi.mock('../pubsub.js', () => ({ pubSub: { publish: vi.fn(), subscribe: () => ({ next: () => new Promise(() => undefined), return: async () => ({ done: true, value: undefined }) }) } }));
vi.mock('./providers/registry.js', () => ({ getProvider: () => providers.current }));

/** Provider simulé : chaque session reste ouverte jusqu'à finish() (fin normale) ; end() la termine proprement. */
function fakeProvider() {
  const handles = new Map<string, { finish: () => void; ctx: RunContext; message: string | undefined }>();
  const provider: SessionProvider = {
    type: 'fake',
    describe: () => ({ type: 'fake', label: 'fake', description: '', interactive: true, configFields: [] }),
    async start(ctx) {
      let resolve!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => (resolve = r));
      await ctx.setActivity('busy');
      handles.set(ctx.session.id, { finish: () => resolve({ exitCode: 0 }), ctx, message: ctx.initialMessage ?? undefined });
      return {
        wait: () => done,
        async stop() {
          resolve({ exitCode: null, closedByServer: true });
          await done;
        },
        async end() {
          resolve({ exitCode: 0 });
        },
        async sendMessage() {
          await ctx.setActivity('busy');
        },
      };
    },
  };
  return { provider, handles };
}

// Les démarrages lisent le commit du dossier (git) : on laisse aux tâches de fond le temps de finir.
const settle = async () => {
  for (let i = 0; i < 50 && [...store.sessions.values()].some((s) => s.status === 'running' && s.activity === null); i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 300));
};
const session = (id: string) => store.sessions.get(id) as unknown as Session;
const eventsOf = (id: string) => store.events.filter((e) => e.sessionId === id);

async function load(settings: Record<string, unknown>) {
  vi.resetModules();
  settingsRepo.get.mockResolvedValueOnce(settings as never);
  const { serverSettings } = await import('../settings/server.js');
  await serverSettings.load();
  const { sessionService } = await import('./service.js');
  return { sessionService, serverSettings };
}

beforeEach(() => {
  store.sessions.clear();
  store.events.length = 0;
  store.projects.clear();
  for (const fn of [...Object.values(repo), ...Object.values(notifications)]) fn.mockClear();
});

describe("file d'attente", () => {
  it('au-delà de la limite du serveur, la session attend puis démarre quand une place se libère', async () => {
    const { sessionService } = await load({ maxConcurrentSessions: 1 });
    const fake = fakeProvider();
    providers.current = fake.provider;
    const a = await sessionService.create({ projectId: 'p', name: 'a', provider: 'fake', prompt: 'premier' });
    const b = await sessionService.create({ projectId: 'p', name: 'b', provider: 'fake', prompt: 'second' });
    expect(a.status).toBe('running');
    expect(b.status).toBe('queued');
    expect(session(b.id).queuedStart).toEqual({ message: null, attachments: [] });
    expect(eventsOf(b.id).find((e) => e.payload.reason === 'queued')?.payload.message).toContain('limite : 1');
    expect(fake.handles.has(b.id)).toBe(false);

    fake.handles.get(a.id)!.finish();
    await settle();
    expect(session(a.id).status).toBe('completed');
    expect(session(b.id)).toMatchObject({ status: 'running', queuedAt: null, queuedStart: null });
    expect(fake.handles.get(b.id)!.message).toBe('second');
  });

  it("une relance par message mise en file garde l'instruction ; on ne peut pas lui en envoyer une autre", async () => {
    const { sessionService } = await load({ maxConcurrentSessions: 1 });
    const fake = fakeProvider();
    providers.current = fake.provider;
    const a = await sessionService.create({ projectId: 'p', name: 'a', provider: 'fake', prompt: 'x' });
    const b = await sessionService.create({ projectId: 'p', name: 'b', provider: 'fake', prompt: 'y', autoStart: false });
    await sessionService.sendMessage(b.id, 'reprends');
    expect(session(b.id).status).toBe('queued');
    await expect(sessionService.sendMessage(b.id, 'autre chose')).rejects.toMatchObject({ code: 'SESSIONS_LIMIT' });

    fake.handles.get(a.id)!.finish();
    await settle();
    expect(fake.handles.get(b.id)!.message).toBe('reprends');
  });

  it("la file est servie dans l'ordre d'arrivée, et la limite d'un projet laisse passer les autres projets", async () => {
    store.projects.set('p1', { id: 'p1', name: 'p1', runnerConfig: { maxSessions: 1 } });
    const { sessionService } = await load({ maxConcurrentSessions: 2 });
    const fake = fakeProvider();
    providers.current = fake.provider;
    const a = await sessionService.create({ projectId: 'p1', name: 'a', provider: 'fake', prompt: 'x' });
    const b = await sessionService.create({ projectId: 'p1', name: 'b', provider: 'fake', prompt: 'x' });
    expect(b.status).toBe('queued');
    expect(eventsOf(b.id).find((e) => e.payload.reason === 'queued')?.payload.message).toContain('dans ce projet');
    const c = await sessionService.create({ projectId: 'p2', name: 'c', provider: 'fake', prompt: 'x' });
    expect(c.status).toBe('running');
    const d = await sessionService.create({ projectId: 'p2', name: 'd', provider: 'fake', prompt: 'x' });
    expect(d.status).toBe('queued');

    // Une place du serveur se libère (c) : b est toujours bloquée par son projet, d passe.
    fake.handles.get(c.id)!.finish();
    await settle();
    expect(session(b.id).status).toBe('queued');
    expect(session(d.id).status).toBe('running');

    fake.handles.get(a.id)!.finish();
    await settle();
    expect(session(b.id).status).toBe('running');
  });

  it("arrêter une session en file la retire de la file", async () => {
    const { sessionService } = await load({ maxConcurrentSessions: 1 });
    const fake = fakeProvider();
    providers.current = fake.provider;
    const a = await sessionService.create({ projectId: 'p', name: 'a', provider: 'fake', prompt: 'x' });
    const b = await sessionService.create({ projectId: 'p', name: 'b', provider: 'fake', prompt: 'x' });
    await sessionService.stop(b.id);
    expect(session(b.id)).toMatchObject({ status: 'stopped', queuedAt: null });
    fake.handles.get(a.id)!.finish();
    await settle();
    expect(fake.handles.has(b.id)).toBe(false);
  });

  it('relever la limite démarre les sessions en attente', async () => {
    const { sessionService, serverSettings } = await load({ maxConcurrentSessions: 1 });
    const fake = fakeProvider();
    providers.current = fake.provider;
    await sessionService.create({ projectId: 'p', name: 'a', provider: 'fake', prompt: 'x' });
    const b = await sessionService.create({ projectId: 'p', name: 'b', provider: 'fake', prompt: 'x' });
    await serverSettings.update({ maxConcurrentSessions: 0 });
    await sessionService.drainQueue();
    expect(session(b.id).status).toBe('running');
  });

  it("sans limite, rien n'est mis en file", async () => {
    const { sessionService } = await load({});
    providers.current = fakeProvider().provider;
    for (let i = 0; i < 5; i++) expect((await sessionService.create({ projectId: 'p', name: `s${i}`, provider: 'fake', prompt: 'x' })).status).toBe('running');
  });

  it("waitForIdle ne considère pas une session en file comme ayant fini son tour", async () => {
    const { sessionService } = await load({ maxConcurrentSessions: 1 });
    const fake = fakeProvider();
    providers.current = fake.provider;
    await sessionService.create({ projectId: 'p', name: 'a', provider: 'fake', prompt: 'x' });
    const b = await sessionService.create({ projectId: 'p', name: 'b', provider: 'fake', prompt: 'x' });
    const waited = await sessionService.waitForIdle(b.id, 50);
    expect(waited.status).toBe('queued');
  });
});

describe('sessions inactives', () => {
  it("une session sans instruction au-delà du délai est terminée sans notification, et libère sa place", async () => {
    const { sessionService } = await load({ maxConcurrentSessions: 1, idleSessionTimeoutMinutes: 30 });
    const fake = fakeProvider();
    providers.current = fake.provider;
    const a = await sessionService.create({ projectId: 'p', name: 'a', provider: 'fake', prompt: 'x' });
    const b = await sessionService.create({ projectId: 'p', name: 'b', provider: 'fake', prompt: 'x' });
    await fake.handles.get(a.id)!.ctx.setActivity('idle');

    expect(await sessionService.endIdleSessions(Date.now() + 10 * 60_000)).toEqual([]);
    expect(await sessionService.endIdleSessions(Date.now() + 31 * 60_000)).toEqual([a.id]);
    await settle();
    expect(session(a.id).status).toBe('completed');
    expect(eventsOf(a.id).some((e) => e.payload.reason === 'idle_timeout')).toBe(true);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(session(b.id).status).toBe('running');
  });

  it("une session qui travaille n'est jamais terminée, ni avec un délai à 0", async () => {
    const { sessionService } = await load({ idleSessionTimeoutMinutes: 0 });
    const fake = fakeProvider();
    providers.current = fake.provider;
    const a = await sessionService.create({ projectId: 'p', name: 'a', provider: 'fake', prompt: 'x' });
    await fake.handles.get(a.id)!.ctx.setActivity('idle');
    expect(await sessionService.endIdleSessions(Date.now() + 24 * 3_600_000)).toEqual([]);
  });
});
