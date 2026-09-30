import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext, RunResult, SessionProvider } from './providers/provider.js';
import type { Session } from './types.js';

// Dépôt des sessions en mémoire, services voisins et provider simulés : on teste le cycle de vie
// (arrêt utilisateur, plantage, arrêt du serveur, maintenance, reprise) sans base ni processus.
const store = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  events: [] as { sessionId: string; type: string; payload: Record<string, unknown> }[],
  seq: 0,
}));
const repo = vi.hoisted(() => ({
  create: vi.fn(async (input: Record<string, unknown>) => {
    const s = { id: `s${++store.seq}`, projectId: 'p', worktreeId: null, parentSessionId: null, name: input.name, provider: input.provider, status: 'pending', activity: null, prompt: input.prompt, promptAttachments: [], config: {}, externalId: null, exitCode: null, error: null };
    store.sessions.set(s.id, s);
    return { ...s };
  }),
  findById: vi.fn(async (id: string) => (store.sessions.has(id) ? { ...store.sessions.get(id) } : null)),
  update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const s = store.sessions.get(id)!;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) s[k] = v;
    return { ...s };
  }),
  markInterrupted: vi.fn(async (id: string) => {
    const s = store.sessions.get(id);
    if (!s || s.status !== 'running') return null;
    Object.assign(s, { status: 'interrupted', exitCode: null, error: null });
    return { ...s };
  }),
  addEvent: vi.fn(async (sessionId: string, type: string, payload: Record<string, unknown>) => {
    store.events.push({ sessionId, type, payload });
    return { id: String(store.events.length), sessionId, type, payload, createdAt: new Date() };
  }),
  countByActivity: vi.fn(async (ids: string[]) => ({
    busy: ids.filter((id) => store.sessions.get(id)!.activity === 'busy').length,
    idle: ids.filter((id) => store.sessions.get(id)!.activity !== 'busy').length,
  })),
  listInterruptedMidTurn: vi.fn(),
}));
const requests = vi.hoisted(() => ({ cancelAllForSession: vi.fn(async () => undefined), ask: vi.fn() }));
const notifications = vi.hoisted(() => ({ notify: vi.fn(async () => undefined) }));
const settingsRepo = vi.hoisted(() => ({ get: vi.fn(async () => null), set: vi.fn(async () => undefined) }));
const providers = vi.hoisted(() => ({ current: null as SessionProvider | null }));

vi.mock('./repository.js', () => ({ sessionRepository: repo }));
vi.mock('../requests/service.js', () => ({ requestService: requests }));
vi.mock('../notifications/service.js', () => ({ notificationService: notifications }));
vi.mock('../settings/repository.js', () => ({ settingsRepository: settingsRepo }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async () => ({ id: 'p', name: 'Projet' }) } }));
vi.mock('../worktrees/service.js', () => ({ worktreeService: { resolveCwd: async () => '/tmp' } }));
vi.mock('../pubsub.js', () => ({ pubSub: { publish: vi.fn() } }));
vi.mock('./providers/registry.js', () => ({ getProvider: () => providers.current }));

/** Flux Claude simulé : il se termine « de lui-même » (die) ou par stop(), comme le provider Claude. */
function fakeProvider(opts: { stopHangs?: boolean } = {}) {
  const handles = new Map<string, { die: (crash: RunResult) => void; ctx: RunContext }>();
  const provider: SessionProvider = {
    type: 'fake',
    describe: () => ({ type: 'fake', label: 'fake', description: '', interactive: true, configFields: [] }),
    async start(ctx) {
      let resolve!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => (resolve = r));
      let stopped = false;
      await ctx.setActivity('busy');
      const die = (crash: RunResult) => resolve(stopped || ctx.isServerStopping() ? { exitCode: null, closedByServer: true } : crash);
      handles.set(ctx.session.id, { die, ctx });
      return {
        wait: () => done,
        async stop() {
          stopped = true;
          if (opts.stopHangs) return new Promise<void>(() => undefined);
          die({ exitCode: null });
          await done;
        },
      };
    },
  };
  return { provider, handles };
}

const crash: RunResult = { exitCode: 1, error: 'Flux terminé sans message de résultat' };
const settle = () => new Promise((r) => setTimeout(r, 20));
const session = (id: string) => store.sessions.get(id) as unknown as Session;
const eventsOf = (id: string) => store.events.filter((e) => e.sessionId === id);

async function load() {
  vi.resetModules();
  const { sessionService } = await import('./service.js');
  const { serverSettings } = await import('../settings/server.js');
  return { sessionService, serverSettings };
}

beforeEach(() => {
  store.sessions.clear();
  store.events.length = 0;
  for (const fn of [...Object.values(repo), ...Object.values(requests), ...Object.values(notifications)]) fn.mockClear();
});

describe('fin de session hors arrêt du serveur', () => {
  it("un arrêt demandé par l'utilisateur donne « stopped » sans erreur", async () => {
    const { sessionService } = await load();
    providers.current = fakeProvider().provider;
    const s = await sessionService.create({ projectId: 'p', name: 'a', provider: 'fake', prompt: 'x' });
    await sessionService.stop(s.id);
    await settle();
    expect(session(s.id)).toMatchObject({ status: 'stopped', error: null });
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("un agent qui meurt de lui-même donne « failed » et une notification", async () => {
    const { sessionService } = await load();
    const fake = fakeProvider();
    providers.current = fake.provider;
    const s = await sessionService.create({ projectId: 'p', name: 'b', provider: 'fake', prompt: 'x' });
    fake.handles.get(s.id)!.die(crash);
    await settle();
    expect(session(s.id)).toMatchObject({ status: 'failed', exitCode: 1, error: crash.error });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.failed' }));
  });
});

describe('arrêt du serveur', () => {
  it('passe les sessions à « interrupted » même si pm2 a tué les agents avant stop()', async () => {
    const { sessionService } = await load();
    const fake = fakeProvider({ stopHangs: true });
    providers.current = fake.provider;
    const ids: string[] = [];
    for (const name of ['c', 'd', 'e']) ids.push((await sessionService.create({ projectId: 'p', name, provider: 'fake', prompt: 'x' })).id);
    await repo.update(ids[2], { activity: 'idle' });
    expect(await sessionService.activeSummary()).toEqual({ active: 3, busy: 2, idle: 1 });

    // Le signal arrive : le backend le note, et l'agent de la première session meurt aussitôt.
    sessionService.beginShutdown();
    fake.handles.get(ids[0])!.die(crash);
    await settle();
    const started = Date.now();
    await sessionService.shutdown(); // le flux des autres ne se ferme jamais : l'arrêt doit rester borné
    expect(Date.now() - started).toBeLessThan(1500);

    for (const id of ids) {
      expect(session(id)).toMatchObject({ status: 'interrupted', exitCode: null, error: null });
      const notices = eventsOf(id).filter((e) => e.type === 'system' && e.payload.reason === 'server_shutdown');
      expect(notices).toHaveLength(1);
      expect(String(notices[0].payload.message)).toMatch(/interrompue par un redémarrage du serveur/);
      expect(eventsOf(id).filter((e) => e.type === 'status').at(-1)!.payload.status).toBe('interrupted');
    }
    // L'activité est conservée : on sait qui était au milieu d'un tour.
    expect(session(ids[0]).activity).toBe('busy');
    expect(session(ids[2]).activity).toBe('idle');
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(requests.cancelAllForSession).toHaveBeenCalledWith(ids[1], 'expired');
    // Plus aucune session ne démarre pendant l'arrêt.
    await expect(sessionService.start(ids[0])).rejects.toMatchObject({ code: 'MAINTENANCE' });
  });
});

describe('mode maintenance', () => {
  it('refuse la création et la relance des sessions, puis les autorise une fois levé', async () => {
    const { sessionService, serverSettings } = await load();
    providers.current = fakeProvider().provider;
    const s = await sessionService.create({ projectId: 'p', name: 'm', provider: 'fake', prompt: 'x', autoStart: false });
    serverSettings.setMaintenance(true, 'mise à jour vers 18 h', null);
    await expect(sessionService.create({ projectId: 'p', name: 'n', provider: 'fake', prompt: 'x' })).rejects.toMatchObject({ code: 'MAINTENANCE', message: expect.stringContaining('mise à jour vers 18 h') });
    await expect(sessionService.sendMessage(s.id, 'reprends')).rejects.toMatchObject({ code: 'MAINTENANCE' });
    serverSettings.setMaintenance(false, null, null);
    await sessionService.sendMessage(s.id, 'reprends');
    expect(session(s.id).status).toBe('running');
  });
});

describe('reprise automatique au démarrage', () => {
  it("relance par défaut les sessions coupées en plein tour, ne fait rien si le réglage est désactivé", async () => {
    const { sessionService, serverSettings } = await load();
    const starts: (string | null)[] = [];
    providers.current = { ...fakeProvider().provider, start: async (ctx) => (starts.push(ctx.initialMessage), { wait: () => new Promise(() => undefined), stop: async () => undefined }) };
    store.sessions.set('x', { id: 'x', projectId: 'p', name: 'x', provider: 'fake', status: 'interrupted', activity: 'busy', prompt: 'p', promptAttachments: [], config: {}, externalId: 'conv' });
    repo.listInterruptedMidTurn.mockResolvedValue([{ ...store.sessions.get('x') }]);

    await serverSettings.update({ autoResumeInterrupted: false });
    expect(await sessionService.resumeInterruptedAfterRestart()).toEqual([]);
    await serverSettings.update({ autoResumeInterrupted: true });
    expect(await sessionService.resumeInterruptedAfterRestart()).toEqual(['x']);
    expect(session('x').status).toBe('running');
    expect(starts[0]).toMatch(/a redémarré/);
    expect(starts[0]).toMatch(/demandes .* annulées/);
    expect(eventsOf('x').some((e) => e.type === 'system' && e.payload.reason === 'auto_resume')).toBe(true);
  });
});
