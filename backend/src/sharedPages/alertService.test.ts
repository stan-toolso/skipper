import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataAlert } from './alerts.js';
import type { DataSource } from './dataSources.js';
import type { SharedPage } from './types.js';

const state = vi.hoisted(() => ({
  alerts: [] as DataAlert[],
  sources: [] as DataSource[],
  notified: [] as Record<string, unknown>[],
  launched: [] as { agent: string | null; text: string }[],
  errors: [] as { id: string; error: string | null }[],
  member: 'member' as string | null,
  sessions: {} as Record<string, { status: string; activity: string | null; archivedAt: Date | null }>,
  launchError: null as string | null,
}));

vi.mock('./alertRepository.js', () => ({
  alertRepository: {
    list: async () => state.alerts.map((a) => ({ ...a })),
    replace: async () => undefined,
    saveEvaluation: async (id: string, s: { state: DataAlert['state']; streak: number; value: unknown; event: string | null; error: string | null }) => {
      const a = state.alerts.find((x) => x.id === id)!;
      Object.assign(a, { state: s.state, streak: s.streak, lastValue: s.value, evaluatedAt: new Date(), error: s.error });
      if (s.event === 'triggered') Object.assign(a, { triggeredAt: new Date(), fireCount: a.fireCount + 1 });
    },
    markSession: async (id: string, sessionId: string) => void Object.assign(state.alerts.find((x) => x.id === id)!, { sessionId, sessionAt: new Date() }),
    setError: async (id: string, error: string | null) => {
      state.errors.push({ id, error });
      Object.assign(state.alerts.find((x) => x.id === id)!, { error });
    },
  },
}));
vi.mock('./dataRepository.js', () => ({ dataSourceRepository: { list: async () => state.sources } }));
vi.mock('./repository.js', () => ({ sharedPageRepository: { snapshotLatest: async () => undefined } }));
vi.mock('./launch.js', async () => ({
  sessionBusy: (await vi.importActual<typeof import('./launch.js')>('./launch.js')).sessionBusy,
  launchArtifactSession: async (_p: unknown, _pr: unknown, opts: { agent: string | null; text: string }) => {
    if (state.launchError) throw new Error(state.launchError);
    state.launched.push({ agent: opts.agent, text: opts.text });
    return `session-${state.launched.length}`;
  },
}));
vi.mock('../sessions/repository.js', () => ({ sessionRepository: { findById: async (id: string) => state.sessions[id] ?? null } }));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: async (n: Record<string, unknown>) => (state.notified.push(n), null) } }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, name: 'Projet' }) } }));
vi.mock('../users/service.js', () => ({ userService: { memberRoleFor: async () => state.member, get: async () => ({ id: 'owner', isAdmin: false }) } }));
vi.mock('../config.js', () => ({ config: { appUrl: 'https://skipper.test' } }));
vi.mock('../log.js', () => ({ log: { info: () => undefined, warn: () => undefined, error: () => undefined } }));

const { alertService } = await import('./alertService.js');
const { parseAlerts } = await import('./alerts.js');

const page = (extra: Partial<SharedPage> = {}): SharedPage => ({ id: 'p1', ownerId: 'owner', title: 'Commandes', description: null, linkAccess: false, publicAccess: false, projectAccess: false, version: 1, projectId: 'pr', sessionId: null, sourcePath: null, agentHandoff: 'manual', historyEnabled: true, kind: 'data', refreshMinutes: 60, dataRefreshedAt: null, viewedAt: null, createdAt: new Date(), updatedAt: new Date(), ...extra });
const source = (data: unknown, extra: Partial<DataSource> = {}): DataSource => ({ id: 's1', pageId: 'p1', name: 'stats', kind: 'sql', config: { item: 'base', database: null, query: 'SELECT 1' }, position: 0, data, rowCount: null, status: 'ok', error: null, durationMs: null, refreshedAt: new Date(), attemptedAt: new Date(), ...extra });
const alert = (input: Record<string, unknown>, id = 'a1'): DataAlert => {
  const [parsed] = parseAlerts([{ name: 'taux', source: 'stats', path: 'rows.0.taux', op: '>', value: 5, ...input } as never], [{ name: 'stats', kind: 'sql' }]);
  return { ...parsed!, id, pageId: 'p1', position: 0, state: 'unknown', streak: 0, lastValue: null, evaluatedAt: null, triggeredAt: null, resolvedAt: null, fireCount: 0, sessionId: null, sessionAt: null, error: null };
};
const taux = (n: number) => (state.sources = [source({ columns: ['taux'], rows: [{ taux: n }] })]);

beforeEach(() => {
  Object.assign(state, { alerts: [], sources: [], notified: [], launched: [], errors: [], member: 'member', sessions: {}, launchError: null });
});

describe('alertService.evaluate', () => {
  it('notifie au franchissement seulement, puis au retour à la normale', async () => {
    state.alerts = [alert({ message: 'Trop d’erreurs' })];
    taux(2);
    expect(await alertService.evaluate(page(), ['stats'])).toEqual([]);
    taux(7);
    const fired = await alertService.evaluate(page(), ['stats']);
    expect(fired.map((f) => f.event)).toEqual(['triggered']);
    taux(9);
    await alertService.evaluate(page(), ['stats']);
    expect(state.notified).toHaveLength(1);
    expect(state.notified[0]).toMatchObject({ type: 'page.alert', title: 'Alerte « taux » · Commandes', userId: 'owner', projectId: 'pr', link: '/shared/p1', payload: { pageId: 'p1', alert: 'taux', event: 'triggered' } });
    expect(state.notified[0]!.message).toBe('Trop d’erreurs · stats.rows.0.taux > 5 — valeur 7');
    taux(1);
    await alertService.evaluate(page(), ['stats']);
    expect(state.notified.map((n) => n.type)).toEqual(['page.alert', 'page.alert_resolved']);
    expect(state.alerts[0]).toMatchObject({ state: 'ok', fireCount: 1 });
  });

  it('ignore les alertes des autres sources', async () => {
    state.alerts = [alert({})];
    taux(9);
    expect(await alertService.evaluate(page(), ['autre'])).toEqual([]);
    expect(state.alerts[0]!.state).toBe('unknown');
  });

  it('notifie le projet, ou personne ; retour à la normale facultatif', async () => {
    state.alerts = [alert({ notify: 'project', notify_resolved: false })];
    taux(9);
    await alertService.evaluate(page(), ['stats']);
    expect(state.notified[0]).toMatchObject({ projectId: 'pr' });
    expect(state.notified[0]!.userId).toBeUndefined();
    taux(1);
    await alertService.evaluate(page(), ['stats']);
    expect(state.notified).toHaveLength(1);
  });

  it('lance une session avec le contexte au déclenchement, pas au retour', async () => {
    state.alerts = [alert({ notify: 'none', path: 'rows.*.taux', prompt: 'Ouvre une tâche pour corriger.' })];
    state.sources = [source({ columns: ['id', 'taux'], rows: [{ id: 1, taux: 1 }, { id: 2, taux: 8 }] })];
    await alertService.evaluate(page(), ['stats']);
    expect(state.notified).toEqual([]);
    expect(state.launched).toHaveLength(1);
    expect(state.launched[0]!.agent).toBeNull();
    expect(state.launched[0]!.text).toContain('Ouvre une tâche pour corriger.');
    expect(state.launched[0]!.text).toContain('{"id":2,"taux":8}');
    expect(state.launched[0]!.text).toContain('https://skipper.test/shared/p1');
    expect(state.alerts[0]!.sessionId).toBe('session-1');
    state.sources = [source({ columns: ['taux'], rows: [{ taux: 1 }] })];
    await alertService.evaluate(page(), ['stats']);
    expect(state.launched).toHaveLength(1);
  });

  it('convoque l’agent nommé', async () => {
    state.alerts = [alert({ agent: 'Ben' })];
    taux(9);
    await alertService.evaluate(page(), ['stats']);
    expect(state.launched[0]!.agent).toBe('Ben');
  });

  it('une session par heure au plus, et jamais tant que la précédente travaille', async () => {
    state.alerts = [{ ...alert({ agent: 'Ben' }), state: 'ok', sessionId: 'old', sessionAt: new Date(Date.now() - 10 * 60_000) }];
    taux(9);
    await alertService.evaluate(page(), ['stats']);
    expect(state.launched).toEqual([]);
    expect(state.alerts[0]!.error).toMatch(/moins de 60 minutes/);
    expect(state.notified).toHaveLength(1);

    state.alerts = [{ ...alert({ agent: 'Ben' }), state: 'ok', sessionId: 'old', sessionAt: new Date(Date.now() - 2 * 3600_000) }];
    state.sessions.old = { status: 'running', activity: 'working', archivedAt: null };
    await alertService.evaluate(page(), ['stats']);
    expect(state.launched).toEqual([]);
    expect(state.alerts[0]!.error).toMatch(/travaille encore/);
  });

  it('garde la raison quand la session ne peut pas être lancée', async () => {
    state.alerts = [alert({ prompt: 'x' })];
    state.launchError = 'Budget mensuel du projet atteint';
    taux(9);
    await alertService.evaluate(page(), ['stats']);
    expect(state.alerts[0]!.error).toBe('Session non lancée : Budget mensuel du projet atteint');
    expect(state.alerts[0]!.state).toBe('firing');

    state.alerts = [alert({ prompt: 'x' })];
    state.launchError = null;
    state.member = null;
    await alertService.evaluate(page(), ['stats']);
    expect(state.launched).toEqual([]);
    expect(state.alerts[0]!.error).toMatch(/plus membre/);
  });

  it('source en erreur : failed se déclenche, un seuil reste en l’état avec une note', async () => {
    state.alerts = [alert({}, 'a1'), alert({ name: 'panne', op: 'failed', value: undefined }, 'a2')];
    state.alerts[0]!.state = 'firing';
    state.sources = [source(null, { status: 'error', error: 'relation inexistante' })];
    const fired = await alertService.evaluate(page(), ['stats']);
    expect(fired.map((f) => f.alert.name)).toEqual(['panne']);
    expect(state.alerts[0]).toMatchObject({ state: 'firing', error: expect.stringMatching(/en erreur/) });
    expect(state.notified[0]!.message).toBe('source stats en erreur — valeur relation inexistante');
  });

  it('anti-rebond : for 2', async () => {
    state.alerts = [alert({ for: 2 })];
    taux(9);
    await alertService.evaluate(page(), ['stats']);
    expect(state.notified).toEqual([]);
    taux(1);
    await alertService.evaluate(page(), ['stats']);
    taux(9);
    await alertService.evaluate(page(), ['stats']);
    expect(state.notified).toEqual([]);
    await alertService.evaluate(page(), ['stats']);
    expect(state.notified).toHaveLength(1);
  });

  it('ne lève jamais', async () => {
    state.alerts = [alert({})];
    state.sources = null as never;
    await expect(alertService.evaluate(page(), ['stats'])).resolves.toEqual([]);
  });
});

describe('alertService.setAlerts', () => {
  it('vérifie les règles contre les sources de l’artefact', async () => {
    state.sources = [source(null)];
    await expect(alertService.setAlerts(page(), [{ name: 'x', source: 'autre', op: 'failed' }])).rejects.toThrow(/source « autre » inconnue/);
    await expect(alertService.setAlerts(page({ kind: 'page' }), [])).rejects.toThrow(/artefact de données/);
    await expect(alertService.setAlerts(page(), [{ name: 'x', source: 'stats', op: 'failed' }])).resolves.toBeDefined();
  });
});
