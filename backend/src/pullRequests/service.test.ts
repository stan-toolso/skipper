import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequest } from '../git/pullRequests.js';
import type { CreateTrackedPullRequestInput, PullRequestActor, TrackedPullRequest, TrackedPullRequestFilter, UpdateTrackedPullRequestInput } from './types.js';

// Dépôt en mémoire, GitHub et travail local des branches simulés : on vérifie l'enregistrement, la mise à jour, la
// synchronisation (GitHub et PR en préparation), les PR d'autres dépôts et les notifications.
const m = vi.hoisted(() => ({
  rows: [] as TrackedPullRequest[],
  github: [] as PullRequest[],
  tasks: [] as Array<{ id: string; projectId: string; title?: string; branch: string | null; status: string }>,
  taskUpdates: [] as Array<[string, Record<string, unknown>]>,
  worksessions: [] as Array<{ id: string; projectId: string; name: string; branch: string; taskId: string | null; archivedAt: Date | null }>,
  /** Travail local par work session (null : dossier absent) et appels reçus (since). */
  local: {} as Record<string, { branch: string; baseBranch: string; commits: number; changes: number } | null>,
  localCalls: [] as Array<[string, Date | null | undefined]>,
  notifications: [] as Array<Record<string, unknown>>,
  created: [] as Array<Record<string, unknown>>,
  isGithub: true,
  listFails: false,
}));

const now = () => new Date();
const applyUpdate = (pr: TrackedPullRequest, input: UpdateTrackedPullRequestInput): TrackedPullRequest => {
  const next = { ...pr, updatedAt: now() };
  if (input.taskId !== undefined) next.taskId = input.taskId;
  if (input.number !== undefined) next.number = input.number;
  if (input.url != null) next.url = input.url;
  if (input.repo != null) next.repo = input.repo;
  if (input.title != null) next.title = input.title;
  if (input.headBranch != null) next.headBranch = input.headBranch;
  if (input.baseBranch != null) next.baseBranch = input.baseBranch;
  if (input.isDraft != null) next.isDraft = input.isDraft;
  if (input.worksessionId !== undefined) next.worksessionId = input.worksessionId;
  if (input.localCommits !== undefined) next.localCommits = input.localCommits;
  if (input.localChanges !== undefined) next.localChanges = input.localChanges;
  if (input.checksState !== undefined) next.checksState = input.checksState;
  if (input.reviewDecision !== undefined) next.reviewDecision = input.reviewDecision;
  if (input.mergeable !== undefined) next.mergeable = input.mergeable;
  if (input.syncedAt !== undefined) next.syncedAt = input.syncedAt;
  if (input.mergeSha !== undefined) next.mergeSha = input.mergeSha;
  if (input.note != null) next.note = input.note;
  if (input.openedAt != null) next.openedAt = input.openedAt;
  if (input.mergedAt !== undefined) next.mergedAt = input.mergedAt;
  if (input.closedAt !== undefined) next.closedAt = input.closedAt;
  if (input.status != null) {
    next.status = input.status;
    if (input.status === 'merged' && input.mergedAt === undefined) next.mergedAt = next.mergedAt ?? now();
    if (input.status === 'closed' && input.closedAt === undefined) next.closedAt = next.closedAt ?? now();
    if (input.status === 'open') Object.assign(next, { mergedAt: null, closedAt: null, mergeSha: null });
  }
  if (input.deployed === true) Object.assign(next, { deployedAt: next.deployedAt ?? now(), deployedByType: input.deployedBy?.type === 'agent' ? 'agent' : 'human', deployedByUserId: input.deployedBy?.userId ?? null, deployedBySessionId: input.deployedBy?.sessionId ?? null, deployNote: input.deployNote ?? '' });
  else if (input.deployed === false) Object.assign(next, { deployedAt: null, deployedByType: null, deployedByUserId: null, deployedBySessionId: null, deployNote: '' });
  return next;
};
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

vi.mock('./repository.js', () => ({
  pullRequestRepository: {
    create: async (projectId: string, input: CreateTrackedPullRequestInput, actor: PullRequestActor) => {
      const pr: TrackedPullRequest = {
        id: `pr${m.rows.length + 1}`,
        projectId,
        taskId: input.taskId ?? null,
        repo: input.repo ?? '',
        number: input.number,
        url: input.url,
        title: input.title,
        headBranch: input.headBranch,
        baseBranch: input.baseBranch ?? '',
        status: input.status ?? (input.number == null ? 'pending' : 'open'),
        isDraft: Boolean(input.isDraft),
        worksessionId: input.worksessionId ?? null,
        localCommits: input.localCommits ?? null,
        localChanges: input.localChanges ?? null,
        checksState: input.checksState ?? null,
        reviewDecision: input.reviewDecision ?? null,
        mergeable: input.mergeable ?? null,
        syncedAt: null,
        mergeSha: null,
        deployedAt: null,
        deployedByType: null,
        deployedByUserId: null,
        deployedBySessionId: null,
        deployNote: '',
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
    findByNumber: async (projectId: string, number: number, repo?: string | null, projectRepo?: string | null) => {
      const all = m.rows.filter((r) => r.projectId === projectId && r.number === number);
      if (repo != null) return all.find((r) => sameRepo(r.repo, repo)) ?? null;
      const own = all.find((r) => sameRepo(r.repo, projectRepo ?? ''));
      if (own) return own;
      return all.length === 1 ? all[0] : null;
    },
    findPendingByWorksession: async (id: string) => m.rows.find((r) => r.worksessionId === id && r.status === 'pending') ?? null,
    list: async (f: TrackedPullRequestFilter = {}) =>
      m.rows.filter(
        (r) =>
          (!f.projectId || r.projectId === f.projectId) &&
          (!f.taskId || r.taskId === f.taskId) &&
          (!f.status || f.status.includes(r.status)) &&
          (!f.headBranch || r.headBranch === f.headBranch) &&
          (!f.worksessionId || r.worksessionId === f.worksessionId),
      ),
    countPending: async () => ({ open: 0, pending: 0, toDeploy: 0 }),
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
  parseRepoFullName: (text: string) => {
    const [owner, name] = text.split('/');
    return owner && name ? { owner, name } : null;
  },
  repoFullName: (r: { owner: string; name: string }) => `${r.owner}/${r.name}`,
  buildDraftText: (branch: string, _commits: unknown[], taskTitle?: string | null) => ({ title: taskTitle ?? `Branche ${branch}`, body: '' }),
  pullRequestService: {
    isGithubProject: async () => m.isGithub,
    list: async () => {
      if (m.listFails) throw new Error('GitHub injoignable');
      return m.github.filter((g) => g.repo === 'acme/app');
    },
    get: async (_p: string, _u: string, number: number, repo?: { owner: string; name: string } | null) => {
      const name = repo ? `${repo.owner}/${repo.name}` : 'acme/app';
      const pr = m.github.find((g) => g.number === number && sameRepo(g.repo, name));
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
vi.mock('../worksessions/repository.js', () => ({
  worksessionRepository: {
    findByBranch: async (projectId: string, branch: string) => m.worksessions.find((w) => w.projectId === projectId && w.branch === branch && !w.archivedAt) ?? null,
    findById: async (id: string) => m.worksessions.find((w) => w.id === id) ?? null,
    listByProject: async (projectId: string) => m.worksessions.filter((w) => w.projectId === projectId && !w.archivedAt),
  },
}));
vi.mock('./local.js', () => ({
  localBranchWork: async (_project: unknown, ws: { id: string }, opts: { since?: Date | null } = {}) => {
    m.localCalls.push([ws.id, opts.since]);
    return m.local[ws.id] ?? null;
  },
}));
vi.mock('../notifications/service.js', () => ({ notificationService: { notify: async (n: Record<string, unknown>) => void m.notifications.push(n) } }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, name: 'Projet', slug: id, gitUrl: m.isGithub ? 'https://github.com/acme/app.git' : 'https://gitlab.com/acme/app.git', gitBranch: 'main' }) } }));

const { describePullRequest, parsePullRequestRef, parsePullRequestUrl, trackedPullRequestService } = await import('./service.js');
const { stageOf } = await import('./types.js');

function gh(number: number, state: PullRequest['state'], over: Partial<PullRequest> = {}): PullRequest {
  const repo = over.repo ?? 'acme/app';
  return {
    projectId: 'p',
    repo,
    number,
    title: `PR ${number}`,
    body: '',
    url: `https://github.com/${repo}/pull/${number}`,
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
const ws = (id: string, branch: string, over: Partial<(typeof m.worksessions)[number]> = {}) => ({ id, projectId: 'p', name: id, branch, taskId: null, archivedAt: null, ...over });

const agent: PullRequestActor = { type: 'agent', sessionId: 's1' };
const human: PullRequestActor = { type: 'human', userId: 'u1' };

beforeEach(() => {
  m.rows = [];
  m.github = [];
  m.tasks = [];
  m.taskUpdates = [];
  m.worksessions = [];
  m.local = {};
  m.localCalls = [];
  m.notifications = [];
  m.created = [];
  m.isGithub = true;
  m.listFails = false;
  vi.useRealTimers();
});

describe('étapes et références', () => {
  it('dérive l’étape du statut, du brouillon et du déploiement', () => {
    expect(stageOf({ status: 'pending', isDraft: false, deployedAt: null })).toBe('pending');
    expect(stageOf({ status: 'open', isDraft: true, deployedAt: null })).toBe('draft');
    expect(stageOf({ status: 'open', isDraft: false, deployedAt: null })).toBe('to_merge');
    expect(stageOf({ status: 'merged', isDraft: false, deployedAt: null })).toBe('to_deploy');
    expect(stageOf({ status: 'merged', isDraft: false, deployedAt: new Date() })).toBe('deployed');
    expect(stageOf({ status: 'closed', isDraft: false, deployedAt: null })).toBe('cancelled');
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
    expect(pr.repo).toBe('acme/app');
    expect(pr.note).toBe('attend la CI');
    expect(pr.createdByType).toBe('agent');
    expect(m.notifications).toHaveLength(1);
    expect(m.notifications[0]).toMatchObject({ type: 'pull_request.opened', projectId: 'p', sessionId: 's1', message: '#5 PR 5 · Projet' });
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

  it('transforme la PR en préparation de la branche en PR ouverte (même objet, note et tâche conservées)', async () => {
    m.worksessions.push(ws('w1', 'task/t7', { taskId: 't7' }));
    m.tasks.push({ id: 't7', projectId: 'p', title: 'Sept', branch: 'task/t7', status: 'in_progress' });
    m.local.w1 = { branch: 'task/t7', baseBranch: 'main', commits: 2, changes: 1 };
    await trackedPullRequestService.sync('p', 'u1', { force: true });
    const pending = m.rows[0];
    expect(pending).toMatchObject({ status: 'pending', number: null, taskId: 't7', worksessionId: 'w1', title: 'Sept', localCommits: 2, localChanges: 1 });
    await trackedPullRequestService.update(pending.id, { note: 'presque prête' }, human);
    const opened = await trackedPullRequestService.recordGithub('p', gh(7, 'OPEN'), agent);
    expect(m.rows).toHaveLength(1);
    expect(opened.id).toBe(pending.id);
    expect(opened).toMatchObject({ status: 'open', number: 7, url: 'https://github.com/acme/app/pull/7', taskId: 't7', note: 'presque prête', worksessionId: 'w1', localCommits: null });
    expect(m.notifications.map((n) => n.type)).toEqual(['pull_request.opened']);
    // Une PR d'un autre dépôt sur la même branche ne remplace pas la PR en préparation du projet.
    m.rows = [];
    await trackedPullRequestService.sync('p', 'u1', { force: true });
    await trackedPullRequestService.recordGithub('p', gh(7, 'OPEN', { repo: 'autre/depot' }), agent);
    expect(m.rows.map((r) => r.status).sort()).toEqual(['open', 'pending']);
  });
});

describe('register', () => {
  it('suit une PR d’un autre dépôt GitHub par son URL, et refuse une référence vide', async () => {
    m.github.push(gh(3, 'OPEN', { repo: 'autre/depot', headRefName: 'feat/ailleurs' }));
    const pr = await trackedPullRequestService.register('p', { url: 'https://github.com/autre/depot/pull/3' }, { userId: 'u1', taskId: null }, agent);
    expect(pr).toMatchObject({ repo: 'autre/depot', number: 3, url: 'https://github.com/autre/depot/pull/3', headBranch: 'feat/ailleurs', taskId: null });
    expect(describePullRequest(pr, 'acme/app')).toContain('PR autre/depot#3');
    expect(m.notifications[0]).toMatchObject({ message: 'autre/depot#3 PR 3 · Projet' });
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
    expect(pr.repo).toBe('acme/app');
    expect(pr.baseBranch).toBe('main');
    expect(pr.title).toBe('À la main');
    const elsewhere = await trackedPullRequestService.register('p', { url: 'https://github.com/autre/depot/pull/9' }, { fallback: { title: 'Ailleurs', headBranch: 'feat/y' } }, agent);
    expect(elsewhere).toMatchObject({ repo: 'autre/depot', number: 9, baseBranch: '' });
    expect(m.rows).toHaveLength(2); // même numéro, deux dépôts
  });
});

describe('update', () => {
  it('n’accepte le déploiement que d’une PR fusionnée, et le retire quand elle est rouverte', async () => {
    const pr = await trackedPullRequestService.recordGithub('p', gh(1, 'OPEN'), human);
    await expect(trackedPullRequestService.update(pr.id, { deployed: true }, human)).rejects.toThrow(/fusionnée/);
    const merged = await trackedPullRequestService.update(pr.id, { status: 'merged' }, agent);
    expect(merged.mergedAt).toBeTruthy();
    const deployed = await trackedPullRequestService.update(pr.id, { deployed: true, deployNote: 'skipper-1' }, agent);
    expect(deployed.deployedAt).toBeTruthy();
    expect(deployed.deployedByType).toBe('agent');
    expect(deployed.deployNote).toBe('skipper-1');
    expect(stageOf(deployed)).toBe('deployed');
    const reopened = await trackedPullRequestService.update(pr.id, { status: 'open' }, human);
    expect(reopened.deployedAt).toBeNull();
    expect(stageOf(reopened)).toBe('to_merge');
  });

  it('refuse de changer le statut d’une PR en préparation (note et tâche seulement)', async () => {
    m.worksessions.push(ws('w1', 'feat/a'));
    m.local.w1 = { branch: 'feat/a', baseBranch: 'main', commits: 0, changes: 3 };
    await trackedPullRequestService.sync('p', 'u1', { force: true });
    const pending = m.rows[0];
    await expect(trackedPullRequestService.update(pending.id, { status: 'merged' }, human)).rejects.toThrow(/pas encore ouverte/);
    await expect(trackedPullRequestService.update(pending.id, { status: 'pending' }, human)).rejects.toThrow(/Statut invalide/);
    expect((await trackedPullRequestService.update(pending.id, { note: 'wip' }, human)).note).toBe('wip');
  });

  it('résout une PR par identifiant, numéro ou URL dans son projet, le dépôt du projet d’abord', async () => {
    const pr = await trackedPullRequestService.recordGithub('p', gh(12, 'OPEN'), human);
    const other = await trackedPullRequestService.recordGithub('p', gh(12, 'OPEN', { repo: 'autre/depot' }), human);
    expect((await trackedPullRequestService.resolve('p', pr.id)).id).toBe(pr.id);
    expect((await trackedPullRequestService.resolve('p', '#12')).id).toBe(pr.id);
    expect((await trackedPullRequestService.resolve('p', 'https://github.com/acme/app/pull/12')).id).toBe(pr.id);
    expect((await trackedPullRequestService.resolve('p', 'https://github.com/autre/depot/pull/12')).id).toBe(other.id);
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
    expect(stageOf(one)).toBe('to_deploy');
    expect(m.notifications.map((n) => n.type)).toEqual(['pull_request.merged']);
    const adopted = after.find((r) => r.number === 3)!;
    expect(adopted).toBeTruthy();
    expect(adopted.taskId).toBe('t3');
    expect(adopted.createdByType).toBe('system');
    expect(adopted.checksState).toBe('PENDING');
    expect(after.find((r) => r.number === 4)).toBeUndefined();
  });

  it('rafraîchit une PR d’un autre dépôt une à une, dans son dépôt', async () => {
    const other = await trackedPullRequestService.recordGithub('p', gh(2, 'OPEN', { repo: 'autre/depot' }), human);
    m.github.push(gh(2, 'MERGED', { repo: 'autre/depot' }), gh(2, 'OPEN')); // #2 du dépôt du projet : une autre PR, ignorée
    const after = await trackedPullRequestService.sync('p', 'u1', { force: true });
    expect(after.find((r) => r.id === other.id)!.status).toBe('merged');
    expect(after).toHaveLength(1);
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

describe('PR en préparation (refreshPending)', () => {
  it('crée une PR en préparation par work session dont la branche porte des modifications, même sans GitHub', async () => {
    m.isGithub = false; // projet git hors GitHub : le travail local compte quand même
    m.worksessions.push(ws('w1', 'feat/a'), ws('w2', 'feat/b'), ws('w3', 'feat/c'), ws('w4', 'feat/d', { archivedAt: new Date() }));
    m.tasks.push({ id: 't1', projectId: 'p', title: 'Tâche A', branch: 'feat/a', status: 'in_progress' });
    m.local.w1 = { branch: 'feat/a', baseBranch: 'main', commits: 3, changes: 0 };
    m.local.w2 = { branch: 'feat/b', baseBranch: 'main', commits: 0, changes: 0 }; // rien à proposer
    m.local.w3 = null; // dossier absent
    const after = await trackedPullRequestService.sync('p', 'u1', { force: true });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'pending', number: null, url: '', repo: '', headBranch: 'feat/a', baseBranch: 'main', taskId: 't1', title: 'Tâche A', worksessionId: 'w1', localCommits: 3, localChanges: 0, createdByType: 'system' });
    expect(stageOf(after[0])).toBe('pending');
    expect(m.localCalls.map(([id]) => id)).toEqual(['w1', 'w2', 'w3']); // la work session archivée n'est pas regardée
    const line = describePullRequest(after[0]);
    expect(line).toContain('branche feat/a « Tâche A » · en préparation (3 commits)');
    expect(line).toContain('pas encore ouverte sur GitHub');
  });

  it('met à jour le travail local, puis retire la PR quand la branche n’a plus rien ou que la work session disparaît', async () => {
    m.worksessions.push(ws('w1', 'feat/a'));
    m.local.w1 = { branch: 'feat/a', baseBranch: 'main', commits: 1, changes: 2 };
    await trackedPullRequestService.sync('p', 'u1', { force: true });
    const id = m.rows[0].id;
    m.local.w1 = { branch: 'feat/a', baseBranch: 'main', commits: 2, changes: 0 };
    await trackedPullRequestService.sync('p', 'u1', { force: true });
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({ id, localCommits: 2, localChanges: 0 });
    m.local.w1 = { branch: 'feat/a', baseBranch: 'main', commits: 0, changes: 0 };
    await trackedPullRequestService.sync('p', 'u1', { force: true });
    expect(m.rows).toHaveLength(0);
    m.local.w1 = { branch: 'feat/a', baseBranch: 'main', commits: 1, changes: 0 };
    await trackedPullRequestService.sync('p', 'u1', { force: true });
    expect(m.rows).toHaveLength(1);
    m.worksessions[0].archivedAt = new Date();
    await trackedPullRequestService.sync('p', 'u1', { force: true });
    expect(m.rows).toHaveLength(0);
  });

  it('ne double pas une PR ouverte sur la branche, et ne compte que les commits postérieurs à une fusion', async () => {
    m.worksessions.push(ws('w1', 'task/t1'));
    m.local.w1 = { branch: 'task/t1', baseBranch: 'main', commits: 4, changes: 0 };
    await trackedPullRequestService.recordGithub('p', gh(1, 'OPEN'), human);
    await trackedPullRequestService.sync('p', 'u1', { force: true });
    expect(m.rows.map((r) => r.status)).toEqual(['open']);
    // Fusionnée (squash : les anciens commits restent « en avance ») : seuls les commits depuis la fusion comptent.
    m.github.push(gh(1, 'MERGED'));
    await trackedPullRequestService.sync('p', 'u1', { force: true });
    expect(m.rows.map((r) => r.status)).toEqual(['merged']);
    expect(m.localCalls.at(-1)).toEqual(['w1', new Date('2026-10-02T10:00:00Z')]);
    m.local.w1 = { branch: 'task/t1', baseBranch: 'main', commits: 1, changes: 0 };
    await trackedPullRequestService.sync('p', 'u1', { force: true });
    expect(m.rows.map((r) => r.status).sort()).toEqual(['merged', 'pending']);
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
    const line = describePullRequest(pr, 'acme/app');
    expect(line).toContain('PR #21 « PR 21 » · à fusionner (conflits avec la base, checks réussis, modifications demandées)');
    expect(line).toContain('task/t21 → main');
    expect(line).toContain('note : à reprendre');
    expect(line).toContain('https://github.com/acme/app/pull/21');
    expect(describePullRequest(pr)).toContain('PR #21'); // sans dépôt du projet connu : le dépôt de la PR est le sien
  });
});
