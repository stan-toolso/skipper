import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackedPullRequest } from './types.js';

// Session rattachée à une PR suivie et demande de résolution des conflits : dépôts et service des sessions simulés.
const m = vi.hoisted(() => ({
  worksessions: [] as Array<{ id: string; projectId: string; branch: string }>,
  sessions: [] as Array<{ id: string; projectId: string; worksessionId: string | null; archivedAt: Date | null; createdAt: Date; status: string }>,
  sent: [] as Array<[string, string]>,
  prs: [] as TrackedPullRequest[],
}));

vi.mock('../worksessions/repository.js', () => ({ worksessionRepository: { findByBranch: async (projectId: string, branch: string) => m.worksessions.find((w) => w.projectId === projectId && w.branch === branch) ?? null } }));
vi.mock('../sessions/repository.js', () => ({
  sessionRepository: {
    list: async (f: { projectId?: string; worksessionId?: string; limit?: number }) =>
      m.sessions
        .filter((s) => (!f.projectId || s.projectId === f.projectId) && (!f.worksessionId || s.worksessionId === f.worksessionId) && !s.archivedAt)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, f.limit ?? 100),
    findById: async (id: string) => m.sessions.find((s) => s.id === id) ?? null,
  },
}));
vi.mock('../sessions/service.js', () => ({
  sessionService: {
    sendMessage: async (id: string, text: string) => {
      m.sent.push([id, text]);
      return m.sessions.find((s) => s.id === id);
    },
  },
}));
vi.mock('./service.js', () => ({
  trackedPullRequestService: {
    get: async (id: string) => {
      const pr = m.prs.find((p) => p.id === id);
      if (!pr) throw new Error('Pull request suivie introuvable');
      return pr;
    },
  },
}));

const { conflictResolutionPrompt, pullRequestSession, requestConflictResolution } = await import('./conflicts.js');

const pr = (over: Partial<TrackedPullRequest> = {}): TrackedPullRequest =>
  ({
    id: 'pr1',
    projectId: 'p',
    taskId: null,
    number: 70,
    url: 'https://github.com/acme/app/pull/70',
    title: 'Fluidité',
    headBranch: 'fluidite',
    baseBranch: 'main',
    status: 'open',
    isDraft: false,
    checksState: 'SUCCESS',
    reviewDecision: null,
    mergeable: 'CONFLICTING',
    syncedAt: null,
    mergeSha: null,
    note: '',
    createdByType: 'agent',
    createdByUserId: null,
    createdBySessionId: null,
    openedAt: new Date(),
    mergedAt: null,
    closedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as TrackedPullRequest;

const session = (id: string, over: Partial<(typeof m.sessions)[number]> = {}) => ({ id, projectId: 'p', worksessionId: null, archivedAt: null, createdAt: new Date('2026-10-30T10:00:00Z'), status: 'completed', ...over });

beforeEach(() => {
  m.worksessions = [];
  m.sessions = [];
  m.sent = [];
  m.prs = [];
});

describe('session rattachée à une PR', () => {
  it('prend la session la plus récente du dossier de travail de la branche', async () => {
    m.worksessions = [{ id: 'w1', projectId: 'p', branch: 'fluidite' }];
    m.sessions = [session('old', { worksessionId: 'w1', createdAt: new Date('2026-10-29T10:00:00Z') }), session('new', { worksessionId: 'w1' }), session('other', { worksessionId: 'w2' })];
    expect((await pullRequestSession(pr()))?.id).toBe('new');
  });

  it('ignore les sessions archivées du dossier et se rabat sur la session qui a ouvert la PR', async () => {
    m.worksessions = [{ id: 'w1', projectId: 'p', branch: 'fluidite' }];
    m.sessions = [session('gone', { worksessionId: 'w1', archivedAt: new Date() }), session('creator')];
    expect((await pullRequestSession(pr({ createdBySessionId: 'creator' })))?.id).toBe('creator');
  });

  it('ne renvoie rien sans dossier ni session créatrice vivante du même projet', async () => {
    expect(await pullRequestSession(pr())).toBeNull();
    m.sessions = [session('creator', { archivedAt: new Date() })];
    expect(await pullRequestSession(pr({ createdBySessionId: 'creator' }))).toBeNull();
    m.sessions = [session('creator', { projectId: 'autre' })];
    expect(await pullRequestSession(pr({ createdBySessionId: 'creator' }))).toBeNull();
  });
});

describe('demande de résolution des conflits', () => {
  it('envoie l’instruction à la session rattachée', async () => {
    m.prs = [pr()];
    m.worksessions = [{ id: 'w1', projectId: 'p', branch: 'fluidite' }];
    m.sessions = [session('s1', { worksessionId: 'w1' })];
    const s = await requestConflictResolution('pr1', { type: 'human', userId: 'u1' });
    expect(s.id).toBe('s1');
    expect(m.sent).toHaveLength(1);
    const [id, text] = m.sent[0];
    expect(id).toBe('s1');
    expect(text).toContain('#70 « Fluidité »');
    expect(text).toContain('git merge origin/main');
    expect(text).toContain('`fluidite`');
    expect(text).not.toContain('autre session');
    expect(conflictResolutionPrompt(pr({ baseBranch: '' }))).toContain('la branche principale');
  });

  it('signale la demande d’un agent et refuse une PR fermée ou sans session', async () => {
    m.prs = [pr({ id: 'pr1' }), pr({ id: 'pr2', status: 'merged' })];
    await expect(requestConflictResolution('pr1', { type: 'human', userId: 'u1' })).rejects.toThrow(/Aucune session/);
    m.sessions = [session('creator')];
    m.prs[0] = pr({ id: 'pr1', createdBySessionId: 'creator' });
    await requestConflictResolution('pr1', { type: 'agent', sessionId: 'sx' });
    expect(m.sent[0][1]).toContain('autre session');
    await expect(requestConflictResolution('pr2', { type: 'human', userId: 'u1' })).rejects.toThrow(/plus ouverte/);
  });
});
