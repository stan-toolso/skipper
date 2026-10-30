import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequest } from '../git/pullRequests.js';
import type { CreateTrackedPullRequestInput, PullRequestActor, TrackedPullRequest, TrackedPullRequestFilter, UpdateTrackedPullRequestInput } from './types.js';

// Dépôt en mémoire et GitHub simulé : on vérifie l'enregistrement, la mise à jour, la synchronisation et les notifications.
const m = vi.hoisted(() => ({
  rows: [] as TrackedPullRequest[],
  github: [] as PullRequest[],
  tasks: [] as Array<{ id: string; projectId: string; branch: string | null; status: string }>,
  taskUpdates: [] as Array<[string, Record<string, unknown>]>,
  worksessions: [] as Array<{ projectId: string; branch: string; taskId: string | null }>,
  notifications: [] as Array<Record<string, unknown>>,
  created: [] as Array<Record<string, unknown>>,
  isGithub: true,
  listFails: false,
}));

const now = () => new Date();
const applyUpdate = (pr: TrackedPullRequest, input: UpdateTrackedPullRequestInput): TrackedPullRequest => {
  const next = { ...pr, updatedAt: now() };
  if (input.taskId !== undefined) next.taskId = input.taskId;
  if (input.title != null) next.title = input.title;
  if (input.baseBranch != null) next.baseBranch = input.baseBranch;
  if (input.isDraft != null) next.isDraft = input.isDraft;
  if (input.checksState !== undefined) next.checksState = input.checksState;
  if (input.reviewDecision !== undefined) next.reviewDecision = input.reviewDecision;
  if (input.mergeable !== undefined) next.mergeable = input.mergeable;
  if (input.syncedAt !== undefined) next.syncedAt = input.syncedAt;
  if (input.mergeSha !== undefined) next.mergeSha = input.mergeSha;
  if (input.note != null) next.note = input.note;
  if (input.mergedAt !== undefined) next.mergedAt = input.mergedAt;
  if (input.closedAt !== undefined) next.closedAt = input.closedAt;
  if (input.status != null) {
    next.status = input.status;
    if (input.status === 'merged' && input.mergedAt === undefined) next.mergedAt = next.mergedAt ?? now();
    if (input.status === 'closed' && input.closedAt === undefined) next.closedAt = next.closedAt ?? now();
    if (input.status === 'open') Object.assign(next, { mergedAt: null, closedAt: null, mergeSha: null });
  }
  return next;
};

vi.mock('./repository.js', () => ({
  pullRequestRepository: {
    create: async (projectId: string, input: CreateTrackedPullRequestInput, actor: PullRequestActor) => {
      const pr: TrackedPullRequest = {
        id: `pr${m.rows.length + 1}`,
        projectId,
        taskId: input.taskId ?? null,
        number: input.number,
        url: input.url,
        title: input.title,
        headBranch: input.headBranch,
        baseBranch: input.baseBranch ?? '',
        status: input.status ?? 'open',
        isDraft: Boolean(input.isDraft),
        checksState: input.checksState ?? null,
        reviewDecision: input.reviewDecision ?? null,
        mergeable: input.mergeable ?? null,
        syncedAt: null,
        mergeSha: null,
        note: input.note ?? '',
        createdByType: actor.type,
        createdByUserId: actor.userId ?? null,
        createdBySessionId: actor.sessionId ?? null,
        openedAt: input.openedAt ?? now(),
        mergedAt: input.mergedAt ?? null,
        closedAt: input.closedAt ?? null,
        createdAt: now(),
        updatedAt: now(),
      };
      m.rows.push(pr);
      m.created.push({ projectId, input, actor });
      return pr;
    },
    findById: async (id: string) => m.rows.find((r) => r.id === id) ?? null,
    findByNumber: async (projectId: string, number: number) => m.rows.find((r) => r.projectId === projectId && r.number === number) ?? null,
    list: async (f: TrackedPullRequestFilter = {}) => m.rows.filter((r) => (!f.projectId || r.projectId === f.projectId) && (!f.taskId || r.taskId === f.taskId)),
    countPending: async () => ({ open: 0 }),
    update: async (id: string, input: UpdateTrackedPullRequestInput) => {
      const i = m.rows.findIndex((r) => r.id === id);
      if (i < 0) return null;
      m.rows[i] = applyUpdate(m.rows[i], input);
      return m.rows[i];
    },
    delete: async (id: string) => {
      const before = m.rows.length;
      m.rows = m.rows.filter((r) => r.id !== id);
      return m.rows.length < before;
    },
  },
}));
vi.mock('../git/pullRequests.js', () => ({
  parseGithubRepo: (url: string | null) => (url?.includes('github.com/acme/app') ? { owner: 'acme', name: 'app' } : null),
  pullRequestService: {
    isGithubProject: async () => m.isGithub,
    list: async () => {
      if (m.listFails) throw new Error('GitHub injoignable');
      return m.github;
    },
    get: async (_p: string, _u: string, number: number) => {
      const pr = m.github.find((g) => g.number === number);
      if (!pr) throw new Error('introuvable');
      return pr;
    },
    create: async (_ref: unknown, _u: string, input: { title: string }) => ({ ...gh(99, 'OPEN'), title: input.title, headRefName: 'task/ouverte' }),
  },
}));
vi.mock('../tasks/service.js', () => ({
  taskService: {
    get: async (id: string) => {
      const t = m.tasks.find((x) => x.id === id);
      if (!t) throw new Error('Tâche introuvable');
      return t;
    },
    forBranch: async (projectId: string, branch: string) => m.tasks.find((t) => t.projectId === projectId && t.branch === branch) ?? null,
    update: async (id: string, patch: Record<string, unknown>) => {
      m.taskUpdates.push([id, patch]);
      const t = m.tasks.find((x) => x.id === id);
      if (t && typeof patch.branch === 'string') t.branch = patch.branch;
      return t;
    },
  },
}));
vi.mock('../worksessions/repository.js', () => ({ worksessionRepository: { findByBranch: async (projectId: string, branch: string) => m.worksessions.find((w) => w.projectId === projectId && w.branch === branch) ?? null } }));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: async (n: Record<string, unknown>) => void m.notifications.push(n) } }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, name: 'Projet', gitUrl: m.isGithub ? 'https://github.com/acme/app.git' : null, gitBranch: 'main' }) } }));

const { describePullRequest, parsePullRequestRef, parsePullRequestUrl, trackedPullRequestService } = await import('./service.js');
const { stageOf } = await import('./types.js');

function gh(number: number, state: PullRequest['state'], over: Partial<PullRequest> = {}): PullRequest {
  return {
    projectId: 'p',
    number,
    title: `PR ${number}`,
    body: '',
    url: `https://github.com/acme/app/pull/${number}`,
    state,
    isDraft: false,
    author: 'stan',
    authorAvatarUrl: null,
    headRefName: `task/t${number}`,
    baseRefName: 'main',
    isCrossRepository: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    checksState: 'SUCCESS',
    checks: [],
    reviews: [],
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    commitCount: 1,
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    mergedAt: state === 'MERGED' ? new Date('2026-10-02T10:00:00Z') : null,
    closedAt: state === 'CLOSED' ? new Date('2026-10-02T10:00:00Z') : null,
    ...over,
  };
}

const agent: PullRequestActor = { type: 'agent', sessionId: 's1' };
const human: PullRequestActor = { type: 'human', userId: 'u1' };

beforeEach(() => {
  m.rows = [];
  m.github = [];
  m.tasks = [];
  m.taskUpdates = [];
  m.worksessions = [];
  m.notifications = [];
  m.created = [];
  m.isGithub = true;
  m.listFails = false;
  vi.useRealTimers();
});

describe('étapes et références', () => {
  it('dérive l’étape du statut, du brouillon et du déploiement', () => {
    expect(stageOf({ status: 'open', isDraft: true })).toBe('draft');
    expect(stageOf({ status: 'open', isDraft: false })).toBe('to_merge');
    expect(stageOf({ status: 'merged', isDraft: false })).toBe('merged');
    expect(stageOf({ status: 'closed', isDraft: false })).toBe('cancelled');
  });

  it('lit le numéro d’une URL GitHub ou d’une référence libre', () => {
    expect(parsePullRequestUrl('https://github.com/acme/app/pull/42')).toEqual({ owner: 'acme', name: 'app', number: 42 });
    expect(parsePullRequestUrl('https://github.com/acme/app/pull/42/files?x=1')?.number).toBe(42);
    expect(parsePullRequestUrl('https://github.com/acme/app/issues/42')).toBeNull();
    expect(parsePullRequestRef('#7')).toBe(7);
    expect(parsePullRequestRef('7')).toBe(7);
    expect(parsePullRequestRef('https://github.com/acme/app/pull/7')).toBe(7);
    expect(parsePullRequestRef('pr1')).toBeNull();
  });
});

describe('recordGithub', () => {
  it('relie la tâche de la branche, lui donne la branche si elle n’en avait pas, et prévient quand un agent ouvre la PR', async () => {
    m.tasks.push({ id: 't1', projectId: 'p', branch: 'task/t5', status: 'in_progress' });
    const pr = await trackedPullRequestService.recordGithub('p', gh(5, 'OPEN'), agent, { note: 'attend la CI' });
    expect(pr.taskId).toBe('t1');
    expect(pr.status).toBe('open');
    expect(pr.note).toBe('attend la CI');
    expect(pr.createdByType).toBe('agent');
    expect(m.notifications).toHaveLength(1);
    expect(m.notifications[0]).toMatchObject({ type: 'pull_request.opened', projectId: 'p', sessionId: 's1' });
    expect(m.taskUpdates).toHaveLength(0); // la tâche avait déjà sa branche
  });

  it('met à jour la PR déjà suivie au lieu d’en créer une seconde', async () => {
    await trackedPullRequestService.recordGithub('p', gh(5, 'OPEN'), human);
    const again = await trackedPullRequestService.recordGithub('p', gh(5, 'OPEN', { title: 'Renommée', isDraft: true }), human);
    expect(m.rows).toHaveLength(1);
    expect(again.title).toBe('Renommée');
    expect(again.isDraft).toBe(true);
    expect(m.notifications).toHaveLength(0);
  });

  it('donne sa branche à une tâche reliée explicitement qui n’en avait pas', async () => {
    m.tasks.push({ id: 't2', projectId: 'p', branch: null, status: 'todo' });
    const pr = await trackedPullRequestService.recordGithub('p', gh(6, 'OPEN'), human, { taskId: 't2' });
    expect(pr.taskId).toBe('t2');
    expect(m.taskUpdates).toEqual([['t2', { branch: 'task/t6' }]]);
  });
});

describe('register', () => {
  it('refuse une URL d’un autre dépôt et une référence vide', async () => {
    await expect(trackedPullRequestService.register('p', { url: 'https://github.com/autre/depot/pull/3' }, {}, human)).rejects.toThrow(/appartient à autre\/depot/);
    await expect(trackedPullRequestService.register('p', {}, {}, human)).rejects.toThrow(/numéro ou l’URL/);
  });

  it('lit les détails sur GitHub quand il répond', async () => {
    m.github.push(gh(8, 'OPEN', { title: 'Depuis GitHub' }));
    const pr = await trackedPullRequestService.register('p', { url: 'https://github.com/acme/app/pull/8' }, { userId: 'u1' }, human);
    expect(pr.title).toBe('Depuis GitHub');
    expect(pr.headBranch).toBe('task/t8');
  });

  it('se contente du titre et de la branche donnés quand GitHub ne répond pas, et exige les deux', async () => {
    await expect(trackedPullRequestService.register('p', { number: 9 }, {}, agent)).rejects.toThrow(/titre et sa branche/);
    const pr = await trackedPullRequestService.register('p', { number: 9 }, { fallback: { title: 'À la main', headBranch: 'feat/x' } }, agent);
    expect(pr.url).toBe('https://github.com/acme/app/pull/9');
    expect(pr.baseBranch).toBe('main');
    expect(pr.title).toBe('À la main');
  });
});

describe('update', () => {
  it('marque fusionnée puis rouvre une PR', async () => {
    const pr = await trackedPullRequestService.recordGithub('p', gh(1, 'OPEN'), human);
    const merged = await trackedPullRequestService.update(pr.id, { status: 'merged' });
    expect(merged.mergedAt).toBeTruthy();
    expect(stageOf(merged)).toBe('merged');
    const reopened = await trackedPullRequestService.update(pr.id, { status: 'open' });
    expect(stageOf(reopened)).toBe('to_merge');
  });

  it('résout une PR par identifiant, numéro ou URL dans son projet', async () => {
    const pr = await trackedPullRequestService.recordGithub('p', gh(12, 'OPEN'), human);
    expect((await trackedPullRequestService.resolve('p', pr.id)).id).toBe(pr.id);
    expect((await trackedPullRequestService.resolve('p', '#12')).id).toBe(pr.id);
    expect((await trackedPullRequestService.resolve('p', 'https://github.com/acme/app/pull/12')).id).toBe(pr.id);
    await expect(trackedPullRequestService.resolve('autre', '#12')).rejects.toThrow(/Aucune pull request/);
  });
});

describe('sync', () => {
  it('recopie l’état GitHub, notifie une fusion faite ailleurs et adopte les PR ouvertes des branches de tâches', async () => {
    const tracked = await trackedPullRequestService.recordGithub('p', gh(1, 'OPEN'), human);
    m.tasks.push({ id: 't3', projectId: 'p', branch: 'task/t3', status: 'in_progress' });
    m.github.push(gh(1, 'MERGED'), gh(3, 'OPEN', { checksState: 'PENDING' }), gh(4, 'OPEN')); // #4 : aucune tâche → ignorée
    const after = await trackedPullRequestService.sync('p', 'u1', { force: true });
    const one = after.find((r) => r.id === tracked.id)!;
    expect(one.status).toBe('merged');
    expect(one.mergedAt).toEqual(new Date('2026-10-02T10:00:00Z'));
    expect(stageOf(one)).toBe('merged');
    expect(m.notifications.map((n) => n.type)).toEqual(['pull_request.merged']);
    const adopted = after.find((r) => r.number === 3)!;
    expect(adopted).toBeTruthy();
    expect(adopted.taskId).toBe('t3');
    expect(adopted.createdByType).toBe('system');
    expect(adopted.checksState).toBe('PENDING');
    expect(after.find((r) => r.number === 4)).toBeUndefined();
  });

  it('laisse la liste telle quelle quand GitHub ne répond pas ou que le projet n’y est pas', async () => {
    await trackedPullRequestService.recordGithub('p', gh(1, 'OPEN'), human);
    m.listFails = true;
    expect((await trackedPullRequestService.sync('p', 'u1', { force: true }))[0].status).toBe('open');
    m.listFails = false;
    m.isGithub = false;
    m.github.push(gh(1, 'MERGED'));
    expect((await trackedPullRequestService.sync('p', 'u1', { force: true }))[0].status).toBe('open');
  });

  it('ne réinterroge pas GitHub avant 30 s sans force', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T10:00:00Z'));
    await trackedPullRequestService.recordGithub('p2', gh(1, 'OPEN'), human);
    await trackedPullRequestService.sync('p2', 'u1', { force: true });
    m.github.push(gh(1, 'MERGED'));
    expect((await trackedPullRequestService.sync('p2', 'u1'))[0].status).toBe('open');
    vi.setSystemTime(new Date('2026-10-30T10:00:31Z'));
    expect((await trackedPullRequestService.sync('p2', 'u1'))[0].status).toBe('merged');
  });
});

describe('open et markMerged', () => {
  it('ouvre la PR sur GitHub puis la suit, reliée à la tâche', async () => {
    m.tasks.push({ id: 't1', projectId: 'p', branch: null, status: 'in_progress' });
    const pr = await trackedPullRequestService.open({ projectId: 'p', worksessionId: 'w1' }, 'u1', { title: 'Ma PR' }, { taskId: 't1' }, agent);
    expect(pr.number).toBe(99);
    expect(pr.title).toBe('Ma PR');
    expect(pr.taskId).toBe('t1');
    expect(m.taskUpdates).toEqual([['t1', { branch: 'task/ouverte' }]]);
    expect(m.notifications[0]).toMatchObject({ type: 'pull_request.opened' });
  });

  it('refuse une tâche d’un autre projet', async () => {
    m.tasks.push({ id: 't1', projectId: 'autre', branch: null, status: 'todo' });
    await expect(trackedPullRequestService.open({ projectId: 'p' }, 'u1', { title: 'x' }, { taskId: 't1' }, agent)).rejects.toThrow(/n’appartient pas/);
  });

  it('marque fusionnée une PR suivie (ou la crée) avec le commit de fusion', async () => {
    const pr = await trackedPullRequestService.markMerged('p', gh(2, 'OPEN'), 'abc123', human);
    expect(pr.status).toBe('merged');
    expect(pr.mergeSha).toBe('abc123');
    expect(m.rows).toHaveLength(1);
  });
});

describe('describePullRequest', () => {
  it('résume une PR sur une ligne avec son étape, ses indices GitHub et sa tâche', async () => {
    const pr = await trackedPullRequestService.recordGithub('p', gh(21, 'OPEN', { mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' }), human, { taskId: null, note: 'à reprendre' });
    const line = describePullRequest(pr);
    expect(line).toContain('PR #21 « PR 21 » · à fusionner (conflits avec la base, checks réussis, modifications demandées)');
    expect(line).toContain('task/t21 → main');
    expect(line).toContain('note : à reprendre');
    expect(line).toContain('https://github.com/acme/app/pull/21');
  });
});
