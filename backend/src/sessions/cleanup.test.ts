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
  listEvents: vi.fn(),
}));
const service = vi.hoisted(() => ({
  isRunning: vi.fn(),
  sendMessage: vi.fn(),
  waitForIdle: vi.fn(),
  end: vi.fn(),
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
  repo.listEvents.mockResolvedValue([]);
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
    expect(repo.update).toHaveBeenCalledWith('s1', { externalId: null, contextTokens: null, resumeDigest: null });
  });

  it("« reset » termine d'abord une session qui attend des instructions, et est reporté si elle ne s'arrête pas", async () => {
    const idle = makeSession({ status: 'running', activity: 'idle', cleanup: { contextAction: 'reset', contextMaxTokens: 100_000 }, contextTokens: 150_000 });
    repo.findById.mockResolvedValue(idle);
    service.isRunning.mockReturnValue(true);
    service.waitForIdle.mockResolvedValue(idle);
    expect(await cleanupService.prepareContext('s1')).toBeNull();
    expect(service.end).toHaveBeenCalledWith('s1');
    expect(repo.update).not.toHaveBeenCalled();
    expect(actions()).toEqual(['skipped']);
  });

  it("« reset » est reporté sans rien arrêter si l'agent travaille", async () => {
    repo.findById.mockResolvedValue(makeSession({ status: 'running', activity: 'busy', cleanup: { contextAction: 'reset', contextMaxTokens: 100_000 }, contextTokens: 150_000 }));
    service.isRunning.mockReturnValue(true);
    expect(await cleanupService.prepareContext('s1')).toBeNull();
    expect(service.end).not.toHaveBeenCalled();
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

describe('contextAction « fresh » (conversation neuve à chaque exécution planifiée)', () => {
  it('est accepté sans seuil', () => {
    expect(normalizeCleanup({ contextAction: 'fresh', contextMaxTokens: null })).toEqual({ contextAction: 'fresh' });
    expect(normalizeCleanup({ retentionDays: 7, contextAction: 'fresh' })).toEqual({ retentionDays: 7, contextAction: 'fresh' });
  });

  it('oublie la conversation quelle que soit la taille du contexte', async () => {
    repo.findById.mockResolvedValue(makeSession({ cleanup: { contextAction: 'fresh' }, contextTokens: 12_000 }));
    service.isRunning.mockReturnValue(false);
    expect(await cleanupService.prepareContext('s1')).toBe('reset');
    expect(repo.update).toHaveBeenCalledWith('s1', { externalId: null, contextTokens: null, resumeDigest: null });
    expect(actions()).toEqual(['reset']);
  });

  it("ne fait rien tant que la session n'a pas de conversation", async () => {
    repo.findById.mockResolvedValue(makeSession({ cleanup: { contextAction: 'fresh' }, externalId: null, contextTokens: null }));
    expect(await cleanupService.prepareContext('s1')).toBeNull();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('termine d\'abord une session qui attend des instructions', async () => {
    const idle = makeSession({ status: 'running', activity: 'idle', cleanup: { contextAction: 'fresh' }, contextTokens: 50_000 });
    repo.findById.mockResolvedValue(idle);
    service.isRunning.mockReturnValueOnce(true).mockReturnValue(false);
    service.waitForIdle.mockResolvedValue(makeSession({ status: 'completed' }));
    expect(await cleanupService.prepareContext('s1')).toBe('reset');
    expect(service.end).toHaveBeenCalledWith('s1');
    expect(repo.update).toHaveBeenCalledWith('s1', { externalId: null, contextTokens: null, resumeDigest: null });
  });
});

describe('resetNow (bandeau de contexte)', () => {
  it("refuse quand l'agent travaille", async () => {
    repo.findById.mockResolvedValue(makeSession({ status: 'running', activity: 'busy', contextTokens: 200_000 }));
    await expect(cleanupService.resetNow('s1', true)).rejects.toBeInstanceOf(AppError);
  });

  it('garde un résumé des derniers échanges pour la prochaine instruction', async () => {
    repo.findById.mockResolvedValue(makeSession({ name: 'Revue', contextTokens: 200_000 }));
    repo.listEvents.mockResolvedValue([
      { id: 'e1', type: 'instruction', payload: { text: 'Fais la revue' } },
      { id: 'e2', type: 'claude.assistant', payload: { message: { content: [{ type: 'text', text: 'Revue faite : RAS.' }] } } },
    ]);
    service.isRunning.mockReturnValue(false);
    await cleanupService.resetNow('s1', true);
    const patch = repo.update.mock.calls[0][1] as { externalId: null; resumeDigest: string | null };
    expect(patch.externalId).toBeNull();
    expect(patch.resumeDigest).toContain('<previous_conversation>');
    expect(patch.resumeDigest).toContain('Revue faite : RAS.');
    expect(actions()).toEqual(['reset']);
    expect(repo.addEvent.mock.calls[0][2]).toMatchObject({ manual: true, summary: true, before: 200_000 });
  });

  it('sans résumé, ne garde rien', async () => {
    repo.findById.mockResolvedValue(makeSession({ contextTokens: 200_000 }));
    service.isRunning.mockReturnValue(false);
    await cleanupService.resetNow('s1', false);
    expect(repo.update).toHaveBeenCalledWith('s1', { externalId: null, contextTokens: null, resumeDigest: null });
    expect(repo.listEvents).not.toHaveBeenCalled();
  });
});

describe('compactNow (bandeau de contexte)', () => {
  it('compacte sans seuil et refuse hors providers compatibles', async () => {
    repo.findById.mockResolvedValue(makeSession({ contextTokens: 160_000 }));
    service.waitForIdle.mockResolvedValue(makeSession({ contextTokens: 30_000 }));
    await cleanupService.compactNow('s1');
    expect(service.sendMessage).toHaveBeenCalledWith('s1', '/compact');
    expect(actions()).toEqual(['compacting', 'compacted']);
    repo.findById.mockResolvedValue(makeSession({ provider: 'shell', contextTokens: 160_000 }));
    await expect(cleanupService.compactNow('s1')).rejects.toBeInstanceOf(AppError);
  });
});
