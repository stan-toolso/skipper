import { beforeEach, describe, expect, it, vi } from 'vitest';

// Réglages par personne et base simulés : on vérifie la famille de chaque type, le filtre et la persistance.
const store = vi.hoisted(() => new Map<string, unknown>());
const userSettingsStore = vi.hoisted(() => ({
  get: vi.fn(async (userId: string, key: string) => store.get(`${userId}/${key}`) ?? null),
  set: vi.fn(async (userId: string, key: string, value: unknown) => {
    store.set(`${userId}/${key}`, value);
  }),
  delete: vi.fn(async (userId: string, key: string) => {
    store.delete(`${userId}/${key}`);
  }),
}));
const pool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../settings/userStore.js', () => ({ userSettingsStore }));
vi.mock('../db/pool.js', () => ({ pool }));

const { PUSH_CATEGORIES, categoryOf, pushPreferencesService, wantsPush } = await import('./preferences.js');

const KNOWN_TYPES = [
  'request.created',
  'session.completed',
  'session.failed',
  'session.created',
  'task.created',
  'task.completed',
  'task.mentioned',
  'task.replied',
  'pull_request.opened',
  'pull_request.merged',
  'pull_request.closed',
  'schedule.run',
  'schedule.blocked',
  'schedule.skipped',
  'schedule.failed',
  'workflow.run',
  'workflow.failed',
  'context.created',
  'page.shared',
  'container.memory_high',
  'container.cpu_saturated',
  'claude.rate_limit',
  'server.memory_low',
];

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('categoryOf / wantsPush', () => {
  it('range chaque type de notification émis par le backend dans une famille', () => {
    for (const type of KNOWN_TYPES) expect(categoryOf(type), type).not.toBeNull();
  });

  it("n'attribue un type qu'à une seule famille", () => {
    const all = PUSH_CATEGORIES.flatMap((c) => c.types);
    expect(new Set(all).size).toBe(all.length);
  });

  it('envoie tout par défaut et coupe une famille entière', () => {
    expect(wantsPush('request.created', [])).toBe(true);
    expect(wantsPush('session.failed', ['sessions'])).toBe(false);
    expect(wantsPush('session.completed', ['sessions'])).toBe(false);
    expect(wantsPush('session.created', ['sessions'])).toBe(true);
  });

  it('envoie toujours un type inconnu', () => {
    expect(categoryOf('mystery.type')).toBeNull();
    expect(wantsPush('mystery.type', ['requests', 'sessions'])).toBe(true);
  });
});

describe('pushPreferencesService', () => {
  it('liste toutes les familles actives par défaut, sans celles des administrateurs pour un membre', async () => {
    const member = await pushPreferencesService.list('u1', false);
    expect(member.every((c) => c.enabled)).toBe(true);
    expect(member.some((c) => c.adminsOnly)).toBe(false);
    const admin = await pushPreferencesService.list('u1', true);
    expect(admin.length).toBe(PUSH_CATEGORIES.length);
  });

  it('coupe et réactive une famille en ne gardant que les familles coupées', async () => {
    const after = await pushPreferencesService.set('u1', false, 'tasks', false);
    expect(after.find((c) => c.key === 'tasks')?.enabled).toBe(false);
    expect(after.filter((c) => !c.enabled).map((c) => c.key)).toEqual(['tasks']);
    expect(store.get('u1/notifications.push')).toEqual({ muted: ['tasks'] });

    await pushPreferencesService.set('u1', false, 'pages', false);
    expect(store.get('u1/notifications.push')).toEqual({ muted: ['pages', 'tasks'] });

    await pushPreferencesService.set('u1', false, 'tasks', true);
    expect(store.get('u1/notifications.push')).toEqual({ muted: ['pages'] });

    // Plus rien de coupé : la clé disparaît (tout reçu par défaut).
    await pushPreferencesService.set('u1', false, 'pages', true);
    expect(store.has('u1/notifications.push')).toBe(false);
    expect(userSettingsStore.delete).toHaveBeenCalledWith('u1', 'notifications.push');
  });

  it('refuse une famille inconnue', async () => {
    await expect(pushPreferencesService.set('u1', false, 'nope', false)).rejects.toThrow(/inconnue/);
  });

  it('tolère une valeur stockée mal formée', async () => {
    store.set('u1/notifications.push', { muted: 'tasks' });
    expect((await pushPreferencesService.list('u1', false)).every((c) => c.enabled)).toBe(true);
    store.set('u1/notifications.push', { muted: ['tasks', 42, null] });
    expect((await pushPreferencesService.list('u1', false)).find((c) => c.key === 'tasks')?.enabled).toBe(false);
  });

  it('lit les familles coupées de plusieurs personnes en une requête', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ user_id: 'u1', value: { muted: ['sessions'] } }, { user_id: 'u2', value: null }] });
    const muted = await pushPreferencesService.mutedOf(['u1', 'u2', 'u3']);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][1]).toEqual(['notifications.push', ['u1', 'u2', 'u3']]);
    expect(muted.get('u1')).toEqual(['sessions']);
    expect(muted.get('u2')).toEqual([]);
    expect(muted.has('u3')).toBe(false);
  });

  it('ne consulte pas la base sans destinataire', async () => {
    expect((await pushPreferencesService.mutedOf([])).size).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
