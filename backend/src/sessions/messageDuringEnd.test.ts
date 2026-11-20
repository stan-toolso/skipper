import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext, RunResult, SessionProvider } from './providers/provider.js';
import type { Session } from './types.js';

// Instruction envoyée pendant la fin d'une session dont le processus vit encore (session Curso 56fd4c13, 17/11/2026),
// sans base ni processus : dépôt en mémoire, provider simulé dont end() ferme l'entrée sans terminer le processus.
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
      const s = { id: `s${++store.seq}`, projectId: input.projectId, worksessionId: input.worksessionId ?? null, parentSessionId: input.parentSessionId ?? null, name: input.name, provider: input.provider, status: 'pending', activity: null, prompt: input.prompt, promptAttachments: [], config: {}, externalId: null, exitCode: null, error: null, queuedAt: null, queuedStart: null };
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
    listInterruptedMidTurn: vi.fn(async () => [...store.sessions.values()].filter((s) => s.status === 'interrupted' && s.activity === 'busy').map((s) => ({ ...s }))),
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
vi.mock('../worksessions/service.js', () => ({ worksessionService: { resolveCwd: async () => '/tmp', assertUsable: async () => ({}) } }));
vi.mock('../pubsub.js', () => ({ pubSub: { publish: vi.fn(), subscribe: () => ({ next: () => new Promise(() => undefined), return: async () => ({ done: true, value: undefined }) }) } }));
vi.mock('./providers/registry.js', () => ({ getProvider: () => providers.current }));

/**
 * Provider simulé à la manière du CLI : end() ferme la file des instructions, mais le processus ne sort qu'à finish()
 * (commande de fond en cours) ; stop() le termine tout de suite.
 */
function lingeringProvider() {
  const runs: { id: string; message: string | undefined; received: string[]; finish: () => void; closed: boolean }[] = [];
  const provider: SessionProvider = {
    type: 'fake',
    describe: () => ({ type: 'fake', label: 'fake', description: '', interactive: true, configFields: [] }),
    async start(ctx) {
      let resolve!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => (resolve = r));
      const run = { id: ctx.session.id, message: ctx.initialMessage ?? undefined, received: [] as string[], finish: () => resolve({ exitCode: 0 }), closed: false };
      runs.push(run);
      await ctx.setActivity('busy');
      return {
        wait: () => done,
        async stop() {
          run.closed = true;
          resolve({ exitCode: null, closedByServer: true });
          await done;
        },
        async end() {
          run.closed = true;
        },
        acceptsMessages: () => !run.closed,
        async sendMessage(text) {
          if (run.closed) throw new Error("La session n'accepte plus d'instructions");
          run.received.push(text);
          await ctx.setActivity('busy');
        },
      };
    },
  };
  return { provider, runs };
}

const settle = () => new Promise((r) => setTimeout(r, 300));
const session = (id: string) => store.sessions.get(id) as unknown as Session;

async function load() {
  vi.resetModules();
  settingsRepo.get.mockResolvedValueOnce({} as never);
  const { serverSettings } = await import('../settings/server.js');
  await serverSettings.load();
  const { sessionService } = await import('./service.js');
  return { sessionService };
}

beforeEach(() => {
  store.sessions.clear();
  store.events.length = 0;
  store.projects.clear();
  for (const fn of [...Object.values(repo), ...Object.values(notifications)]) fn.mockClear();
});

describe('instruction pendant la fin de la session', () => {
  it("relance la session avec l'instruction au lieu de la perdre, même envoyée deux fois de suite", async () => {
    const { sessionService } = await load();
    const fake = lingeringProvider();
    providers.current = fake.provider;
    const s = await sessionService.create({ projectId: 'p', worksessionId: 'w1', name: 's', provider: 'fake', prompt: 'travaille' });
    await settle();
    await sessionService.end(s.id, { quiet: true });
    expect(fake.runs[0].closed).toBe(true);
    expect(session(s.id).status).toBe('running');

    const [first, second] = await Promise.all([sessionService.sendMessage(s.id, 'le son est coupé'), sessionService.sendMessage(s.id, 'et la fin sonore ?')]);
    await settle();
    expect(fake.runs).toHaveLength(2);
    expect(fake.runs[1].message).toBe('le son est coupé');
    expect(fake.runs[1].received).toEqual(['et la fin sonore ?']);
    expect(first.status).toBe('running');
    expect(second.status).toBe('running');
    expect(session(s.id).status).toBe('running');
    expect(store.events.some((e) => e.payload.reason === 'relaunch_for_message')).toBe(true);
    // L'ancien processus arrêté pour la relance n'est ni un arrêt ni une fin : pas de statut « stopped » ni de notification.
    expect(store.events.some((e) => e.type === 'status' && e.payload.status === 'stopped')).toBe(false);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("une session qui accepte encore des instructions les reçoit dans le même processus", async () => {
    const { sessionService } = await load();
    const fake = lingeringProvider();
    providers.current = fake.provider;
    const s = await sessionService.create({ projectId: 'p', worksessionId: 'w1', name: 's', provider: 'fake', prompt: 'travaille' });
    await settle();
    await sessionService.sendMessage(s.id, 'suite');
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0].received).toEqual(['suite']);
  });
});
