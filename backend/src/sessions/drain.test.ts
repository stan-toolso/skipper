import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext, RunResult, SessionProvider } from './providers/provider.js';
import type { Session } from './types.js';

// Déploiement bleu/vert, côté sessions, sans base ni processus : drainage d'une instance (sessions garées à la fin de
// leur tour), relance d'une session garée par l'instance qui reçoit l'instruction, et actions transmises à l'instance
// qui tient le processus. Le registre des instances et les appels internes sont simulés.
const store = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  events: [] as { sessionId: string; type: string; payload: Record<string, unknown> }[],
  seq: 0,
}));
const repo = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  create: vi.fn(async (input: Record<string, unknown>) => {
    const s = { id: `s${++store.seq}`, projectId: 'p', worksessionId: null, parentSessionId: null, name: input.name, provider: input.provider, status: 'pending', activity: null, prompt: input.prompt, promptAttachments: [], config: {}, externalId: null, exitCode: null, error: null, instanceId: null, parkedAt: null };
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
    Object.assign(s, { status: 'interrupted', instanceId: null });
    return { ...s };
  }),
  claimParked: vi.fn(async (id: string, instanceId: string) => {
    const s = store.sessions.get(id);
    if (!s || s.status !== 'running' || !s.parkedAt) return false;
    Object.assign(s, { parkedAt: null, instanceId });
    return true;
  }),
  addEvent: vi.fn(async (sessionId: string, type: string, payload: Record<string, unknown>) => {
    store.events.push({ sessionId, type, payload });
    return { id: String(store.events.length), sessionId, type, payload, createdAt: new Date() };
  }),
  listQueued: vi.fn(async () => []),
}));
const requests = vi.hoisted(() => ({ cancelAllForSession: vi.fn(async () => undefined), ask: vi.fn() }));
const notifications = vi.hoisted(() => ({ notify: vi.fn(async () => undefined) }));
const settingsRepo = vi.hoisted(() => ({ get: vi.fn(async () => null), set: vi.fn(async () => undefined) }));
const providers = vi.hoisted(() => ({ current: null as SessionProvider | null }));
const instances = vi.hoisted(() => ({ peers: [] as { id: string; port: number; token: string; label: string; pid: number; draining: boolean }[] }));
const client = vi.hoisted(() => ({ callInstance: vi.fn(async (..._args: unknown[]) => null) }));

vi.mock('./repository.js', () => ({ sessionRepository: repo }));
vi.mock('../requests/service.js', () => ({ requestService: requests }));
vi.mock('../notifications/service.js', () => ({ notificationService: notifications }));
vi.mock('../settings/repository.js', () => ({ settingsRepository: settingsRepo }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, name: 'Projet' }) } }));
vi.mock('../worksessions/service.js', () => ({ worksessionService: { resolveCwd: async () => '/tmp', assertUsable: async () => ({}) } }));
vi.mock('../pubsub.js', () => ({ pubSub: { publish: vi.fn() } }));
vi.mock('./providers/registry.js', () => ({ getProvider: () => providers.current }));
vi.mock('../runners/monitor.js', () => ({ containerMonitor: { explainFailure: async () => null } }));
vi.mock('../git/service.js', () => ({ headCommitOf: async () => null }));
vi.mock('../instances/client.js', () => client);
vi.mock('../instances/registry.js', () => ({
  instanceRegistry: {
    id: 'me',
    isSelf: (id: string | null | undefined) => id === 'me',
    hasPeers: () => instances.peers.length > 0,
    holder: async (id: string | null | undefined) => (id && id !== 'me' ? (instances.peers.find((p) => p.id === id) ?? null) : null),
    activePeer: async () => instances.peers.find((p) => !p.draining) ?? null,
  },
}));

/** Provider simulé : l'agent travaille au démarrage ; `finishTurn` le fait attendre une instruction. */
function fakeProvider() {
  const handles = new Map<string, { ctx: RunContext; messages: string[] }>();
  const provider: SessionProvider = {
    type: 'fake',
    describe: () => ({ type: 'fake', label: 'fake', description: '', interactive: true, configFields: [] }),
    async start(ctx) {
      let resolve!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => (resolve = r));
      await ctx.setActivity('busy');
      const entry = { ctx, messages: [ctx.initialMessage ?? ''] };
      handles.set(ctx.session.id, entry);
      return {
        wait: () => done,
        async stop() {
          resolve({ exitCode: null, closedByServer: true });
          await done;
        },
        sendMessage: async (text: string) => {
          entry.messages.push(text);
          await ctx.setActivity('busy');
        },
        interrupt: async () => undefined,
      };
    },
  };
  const finishTurn = (id: string) => handles.get(id)!.ctx.setActivity('idle');
  return { provider, handles, finishTurn };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const session = (id: string) => store.sessions.get(id) as unknown as Session;
const peer = (id: string, draining = false) => ({ id, port: 4102, token: 't', label: id, pid: 1, draining });

async function load() {
  vi.resetModules();
  const { sessionService } = await import('./service.js');
  return { sessionService };
}

beforeEach(() => {
  store.sessions.clear();
  store.events.length = 0;
  instances.peers = [];
  for (const fn of [...Object.values(repo), ...Object.values(requests), ...Object.values(notifications), client.callInstance]) fn.mockClear();
});

describe('drainage d’une instance', () => {
  it('gare les sessions en attente tout de suite, les autres à la fin de leur tour, sans fin ni notification', async () => {
    const { sessionService } = await load();
    const fake = fakeProvider();
    providers.current = fake.provider;
    const idle = await sessionService.create({ projectId: 'p', worksessionId: 'w1', name: 'idle', provider: 'fake', prompt: 'x' });
    const busy = await sessionService.create({ projectId: 'p', worksessionId: 'w2', name: 'busy', provider: 'fake', prompt: 'x' });
    expect(session(idle.id).instanceId).toBe('me');
    await fake.finishTurn(idle.id);

    sessionService.beginDrain();
    await settle();
    expect(session(idle.id)).toMatchObject({ status: 'running', activity: 'idle', instanceId: null });
    expect(session(idle.id).parkedAt).toBeInstanceOf(Date);
    expect(session(busy.id)).toMatchObject({ status: 'running', activity: 'busy', instanceId: 'me', parkedAt: null });
    expect(sessionService.localCount()).toBe(1);

    // Le tour se termine : la session est garée à son tour, l'instance n'a plus rien.
    await fake.finishTurn(busy.id);
    await settle();
    expect(session(busy.id)).toMatchObject({ status: 'running', activity: 'idle', instanceId: null });
    expect(sessionService.localCount()).toBe(0);
    expect(store.events.filter((e) => e.type === 'status')).toEqual([]);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("transmet le démarrage d'une session à l'instance qui la remplace", async () => {
    const { sessionService } = await load();
    providers.current = fakeProvider().provider;
    instances.peers = [peer('green')];
    const s = await sessionService.create({ projectId: 'p', worksessionId: 'w1', name: 'n', provider: 'fake', prompt: 'x', autoStart: false });
    sessionService.beginDrain();
    await sessionService.start(s.id, 'va');
    expect(client.callInstance).toHaveBeenCalledWith(expect.objectContaining({ id: 'green' }), 'session.start', expect.objectContaining({ id: s.id, message: 'va' }));
    expect(sessionService.localCount()).toBe(0);
  });

  it("refuse le démarrage s'il n'y a pas d'instance pour prendre le relais", async () => {
    const { sessionService } = await load();
    providers.current = fakeProvider().provider;
    const s = await sessionService.create({ projectId: 'p', worksessionId: 'w1', name: 'n', provider: 'fake', prompt: 'x', autoStart: false });
    sessionService.beginDrain();
    await expect(sessionService.start(s.id)).rejects.toMatchObject({ code: 'MAINTENANCE' });
  });

  it("à l'arrêt (délai dépassé), gare les sessions en attente et n'interrompt que celles au travail", async () => {
    const { sessionService } = await load();
    const fake = fakeProvider();
    providers.current = fake.provider;
    const a = await sessionService.create({ projectId: 'p', worksessionId: 'w1', name: 'a', provider: 'fake', prompt: 'x' });
    const b = await sessionService.create({ projectId: 'p', worksessionId: 'w2', name: 'b', provider: 'fake', prompt: 'x' });
    sessionService.beginDrain();
    sessionService.beginShutdown();
    await fake.finishTurn(a.id); // fin de tour pendant l'arrêt : garée par shutdown()
    expect(await sessionService.shutdown()).toBe(1);
    await settle();
    expect(session(a.id)).toMatchObject({ status: 'running', activity: 'idle', instanceId: null });
    expect(session(b.id)).toMatchObject({ status: 'interrupted', activity: 'busy' });
  });
});

describe('session garée', () => {
  it("est relancée par l'instance qui reçoit l'instruction, avec la conversation", async () => {
    const { sessionService } = await load();
    const fake = fakeProvider();
    providers.current = fake.provider;
    store.sessions.set('g', { id: 'g', projectId: 'p', name: 'g', provider: 'fake', status: 'running', activity: 'idle', prompt: 'p', promptAttachments: [], config: {}, externalId: 'conv', instanceId: null, parkedAt: new Date() });
    await sessionService.sendMessage('g', 'continue');
    expect(repo.claimParked).toHaveBeenCalledWith('g', 'me');
    expect(fake.handles.get('g')!.messages).toEqual(['continue']);
    expect(session('g')).toMatchObject({ status: 'running', activity: 'busy', instanceId: 'me', parkedAt: null });
  });

  it("s'arrête sans processus, et une interruption n'a rien à faire", async () => {
    const { sessionService } = await load();
    providers.current = fakeProvider().provider;
    store.sessions.set('g', { id: 'g', projectId: 'p', name: 'g', provider: 'fake', status: 'running', activity: 'idle', prompt: 'p', promptAttachments: [], config: {}, externalId: 'conv', instanceId: null, parkedAt: new Date() });
    expect((await sessionService.interrupt('g')).status).toBe('running');
    await sessionService.stop('g');
    expect(session('g')).toMatchObject({ status: 'stopped', activity: null, parkedAt: null });
  });
});

describe('session tenue par une autre instance', () => {
  it("lui transmet instruction, interruption et arrêt", async () => {
    const { sessionService } = await load();
    providers.current = fakeProvider().provider;
    instances.peers = [peer('blue', true)];
    store.sessions.set('r', { id: 'r', projectId: 'p', name: 'r', provider: 'fake', status: 'running', activity: 'busy', prompt: 'p', promptAttachments: [], config: {}, externalId: 'conv', instanceId: 'blue', parkedAt: null });
    await sessionService.sendMessage('r', 'et aussi ceci');
    await sessionService.interrupt('r');
    await sessionService.stop('r');
    expect(client.callInstance.mock.calls.map((c) => c[1])).toEqual(['session.message', 'session.interrupt', 'session.stop']);
    expect(client.callInstance.mock.calls[0][2]).toMatchObject({ id: 'r', text: 'et aussi ceci', attachments: [] });
    expect(sessionService.localCount()).toBe(0);
  });
});
