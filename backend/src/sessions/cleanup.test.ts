import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import type { Session } from './types.js';

// Le dépôt et le service des sessions touchent la base et les processus : on les simule.
const repo = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  addEvent: vi.fn(),
  deleteEventsBefore: vi.fn(),
  listWithRetention: vi.fn(),
}));
const service = vi.hoisted(() => ({
  isRunning: vi.fn(),
  sendMessage: vi.fn(),
  waitForIdle: vi.fn(),
}));
vi.mock('./repository.js', () => ({ sessionRepository: repo }));
vi.mock('./service.js', () => ({ sessionService: service }));
vi.mock('../pubsub.js', () => ({ pubSub: { publish: vi.fn() } }));

const { cleanupService, normalizeCleanup } = await import('./cleanup.js');

const makeSession = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    projectId: 'p1',
    provider: 'claude',
    status: 'completed',
    activity: null,
    externalId: 'conv-1',
    cleanup: {},
    contextTokens: null,
    ...overrides,
  }) as Session;

/** Actions des événements `cleanup` émis pendant le test. */
const actions = () => repo.addEvent.mock.calls.map((c) => (c[2] as { action: string }).action);

beforeEach(() => {
  for (const fn of [...Object.values(repo), ...Object.values(service)]) fn.mockReset();
  repo.addEvent.mockResolvedValue({ id: '1' });
});

describe('normalizeCleanup', () => {
  it('garde des réglages valides et retire les options absentes', () => {
    expect(normalizeCleanup({ retentionDays: 30, contextAction: 'compact', contextMaxTokens: 100_000 })).toEqual({ retentionDays: 30, contextAction: 'compact', contextMaxTokens: 100_000 });
    expect(normalizeCleanup({ retentionDays: null, contextAction: null })).toEqual({});
  });

  it('refuse une durée de conservation nulle, négative ou non entière', () => {
    for (const retentionDays of [0, -3, 1.5]) expect(() => normalizeCleanup({ retentionDays })).toThrow(AppError);
  });

  it('refuse une action inconnue et un seuil trop bas ou absent', () => {
    expect(() => normalizeCleanup({ contextAction: 'delete' as never, contextMaxTokens: 50_000 })).toThrow(AppError);
    expect(() => normalizeCleanup({ contextAction: 'reset', contextMaxTokens: 500 })).toThrow(AppError);
    expect(() => normalizeCleanup({ contextAction: 'compact' })).toThrow(AppError);
  });
});

describe('applyRetention', () => {
  it('ne supprime rien sans durée de conservation', async () => {
    expect(await cleanupService.applyRetention(makeSession())).toBe(0);
    expect(repo.deleteEventsBefore).not.toHaveBeenCalled();
  });

  it('supprime les événements plus vieux que la durée et le signale', async () => {
    repo.deleteEventsBefore.mockResolvedValue(12);
    const before = Date.now();
    expect(await cleanupService.applyRetention(makeSession({ cleanup: { retentionDays: 7 } }))).toBe(12);
    const cutoff = (repo.deleteEventsBefore.mock.calls[0][1] as Date).getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(before - cutoff).toBeLessThanOrEqual(7 * 86_400_000 + 1000);
    expect(actions()).toEqual(['purged']);
  });
});

describe('prepareContext', () => {
  it('ne fait rien sous le seuil ou quand la taille est inconnue', async () => {
    repo.findById.mockResolvedValue(makeSession({ cleanup: { contextAction: 'compact', contextMaxTokens: 100_000 }, contextTokens: 99_999 }));
    expect(await cleanupService.prepareContext('s1')).toBeNull();
    repo.findById.mockResolvedValue(makeSession({ cleanup: { contextAction: 'compact', contextMaxTokens: 100_000 }, contextTokens: null }));
    expect(await cleanupService.prepareContext('s1')).toBeNull();
    expect(service.sendMessage).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('au-delà du seuil, « reset » oublie la conversation du modèle', async () => {
    repo.findById.mockResolvedValue(makeSession({ cleanup: { contextAction: 'reset', contextMaxTokens: 100_000 }, contextTokens: 150_000 }));
    service.isRunning.mockReturnValue(false);
    expect(await cleanupService.prepareContext('s1')).toBe('reset');
    expect(repo.update).toHaveBeenCalledWith('s1', { externalId: null, contextTokens: null });
  });

  it('« reset » est reporté si la session tourne', async () => {
    repo.findById.mockResolvedValue(makeSession({ status: 'running', activity: 'idle', cleanup: { contextAction: 'reset', contextMaxTokens: 100_000 }, contextTokens: 150_000 }));
    service.isRunning.mockReturnValue(true);
    expect(await cleanupService.prepareContext('s1')).toBeNull();
    expect(repo.update).not.toHaveBeenCalled();
    expect(actions()).toEqual(['skipped']);
  });

  it('au-delà du seuil, « compact » envoie /compact et attend la fin du tour', async () => {
    repo.findById.mockResolvedValue(makeSession({ cleanup: { contextAction: 'compact', contextMaxTokens: 100_000 }, contextTokens: 150_000 }));
    service.waitForIdle.mockResolvedValue(makeSession({ contextTokens: 20_000 }));
    expect(await cleanupService.prepareContext('s1')).toBe('compacted');
    expect(service.sendMessage).toHaveBeenCalledWith('s1', '/compact');
    expect(actions()).toEqual(['compacting', 'compacted']);
  });

  it("« compact » est reporté si l'agent travaille, et refusé hors provider Claude", async () => {
    repo.findById.mockResolvedValue(makeSession({ status: 'running', activity: 'busy', cleanup: { contextAction: 'compact', contextMaxTokens: 100_000 }, contextTokens: 150_000 }));
    expect(await cleanupService.prepareContext('s1')).toBeNull();
    repo.findById.mockResolvedValue(makeSession({ provider: 'shell', cleanup: { contextAction: 'compact', contextMaxTokens: 100_000 }, contextTokens: 150_000 }));
    expect(await cleanupService.prepareContext('s1')).toBeNull();
    expect(service.sendMessage).not.toHaveBeenCalled();
  });
});

describe('applyNow', () => {
  it("refuse une session sans réglage de nettoyage", async () => {
    repo.findById.mockResolvedValue(makeSession());
    await expect(cleanupService.applyNow('s1')).rejects.toBeInstanceOf(AppError);
  });
});
