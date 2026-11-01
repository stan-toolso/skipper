import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';

// L'ordre compte : interrompre les sessions avant de supprimer le conteneur (sinon leur mort passe pour
// une erreur), et ne les reprendre qu'une fois le nouveau conteneur prêt.
const calls = vi.hoisted(() => [] as string[]);
const sessions = vi.hoisted(() => ({
  interruptForRunner: vi.fn(async (_projectId: string, reason: string) => {
    calls.push(`interrupt:${reason}`);
    return [{ id: 's1', activity: 'busy' }, { id: 's2', activity: 'idle' }];
  }),
  resumeAfterRunner: vi.fn(async (list: { id: string }[]) => {
    calls.push('resume');
    return list.map((s) => s.id);
  }),
}));
const docker = vi.hoisted(() => ({
  containerName: () => 'skipper-p',
  remove: vi.fn(async () => void calls.push('remove')),
  ensureReady: vi.fn(async () => void calls.push('ensureReady')),
  stop: vi.fn(async () => void calls.push('stop')),
}));
const previews = vi.hoisted(() => ({
  liveWorksessions: vi.fn(async () => {
    calls.push('previews');
    return ['w1'];
  }),
  restartAll: vi.fn(async (ids: string[]) => {
    calls.push('restartPreviews');
    return ids;
  }),
}));
vi.mock('../sessions/service.js', () => ({ sessionService: sessions }));
vi.mock('../previews/service.js', () => ({ previewService: previews }));
vi.mock('./index.js', () => ({ runner: docker }));

const project = { id: 'p', slug: 'p', name: 'P' } as Project;

beforeEach(() => {
  calls.length = 0;
  sessions.interruptForRunner.mockClear();
  sessions.resumeAfterRunner.mockClear();
  docker.ensureReady.mockImplementation(async () => void calls.push('ensureReady'));
});

describe('runnerLifecycle', () => {
  it('reset : interrompt, supprime, recrée, puis reprend toutes les sessions interrompues et relance les aperçus', async () => {
    const { runnerLifecycle } = await import('./lifecycle.js');
    const result = await runnerLifecycle.reset(project);
    expect(calls).toEqual(['previews', 'interrupt:runner_reset', 'remove', 'ensureReady', 'resume', 'restartPreviews']);
    expect(result).toEqual({ interrupted: ['s1', 's2'], resumed: ['s1', 's2'], previews: ['w1'] });
  });

  it('reset : un conteneur impossible à recréer laisse les sessions interrompues et remonte l’erreur', async () => {
    const { runnerLifecycle } = await import('./lifecycle.js');
    docker.ensureReady.mockRejectedValueOnce(new Error('image absente'));
    await expect(runnerLifecycle.reset(project)).rejects.toThrow('image absente');
    expect(calls).toEqual(['previews', 'interrupt:runner_reset', 'remove']);
    expect(sessions.resumeAfterRunner).not.toHaveBeenCalled();
  });

  it('stop : interrompt les sessions puis arrête le conteneur, sans reprise', async () => {
    const { runnerLifecycle } = await import('./lifecycle.js');
    const result = await runnerLifecycle.stop(project);
    expect(calls).toEqual(['interrupt:runner_stop', 'stop']);
    expect(result).toEqual({ interrupted: ['s1', 's2'] });
    expect(sessions.resumeAfterRunner).not.toHaveBeenCalled();
  });
});
