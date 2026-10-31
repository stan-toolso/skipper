import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../sessions/types.js';
import { reviewOf, type SessionReview } from './types.js';

// Revue de code par un agent : lancement (dossier de travail, diff, consigne) et publication du rapport ;
// dépôts, git, GitHub et service des sessions simulés.
const m = vi.hoisted(() => ({
  project: { id: 'p', slug: 'app', gitUrl: 'https://github.com/acme/app.git', gitBranch: 'main' } as Record<string, unknown>,
  worksessions: [] as Array<{ id: string; projectId: string; branch: string; taskId: string | null; archivedAt: Date | null }>,
  sessions: [] as Session[],
  prs: [] as Array<Record<string, unknown>>,
  tasks: [] as Array<{ id: string; projectId: string; title: string; description: string; branch: string | null }>,
  diff: null as null | { branch: string | null; baseBranch: string; mergeBase: string; commits: number; stat: string; patch: string },
  created: [] as Array<Record<string, unknown>>,
  createdWorksessions: [] as Array<Record<string, unknown>>,
  deletedWorksessions: [] as string[],
  comments: [] as Array<{ taskId: string; body: string }>,
  githubComments: [] as Array<{ number: number; body: string; userId: string | null }>,
  githubFails: false,
  lastResult: null as Record<string, unknown> | null,
  ended: [] as string[],
  running: new Set<string>(),
}));

vi.mock('../config.js', () => ({ config: { appUrl: 'https://skipper.test' } }));
vi.mock('../projects/service.js', () => ({ projectService: { get: async () => m.project } }));
vi.mock('../git/service.js', () => ({ gitService: { fetch: async () => undefined, branchPatch: async () => m.diff } }));
vi.mock('../git/pullRequests.js', () => ({
  pullRequestService: {
    comment: async (_projectId: string, userId: string | null, number: number, body: string) => {
      if (m.githubFails) throw new Error('GitHub non connecté');
      m.githubComments.push({ number, body, userId });
      return `https://github.com/acme/app/pull/${number}#issuecomment-1`;
    },
  },
}));
vi.mock('../pullRequests/service.js', () => ({
  projectRepoName: () => 'acme/app',
  foreignRepoOf: (pr: { repo: string }, repo: string) => (pr.repo.toLowerCase() === repo.toLowerCase() ? null : { owner: 'x', name: 'y' }),
  trackedPullRequestService: {
    get: async (id: string) => {
      const pr = m.prs.find((p) => p.id === id);
      if (!pr) throw new Error('Pull request suivie introuvable');
      return pr;
    },
    list: async (f: { headBranch?: string; status?: string[] }) => m.prs.filter((p) => (!f.headBranch || p.headBranch === f.headBranch) && (!f.status || f.status.includes(p.status as string))),
  },
}));
vi.mock('../worksessions/repository.js', () => ({
  worksessionRepository: {
    findById: async (id: string) => m.worksessions.find((w) => w.id === id) ?? null,
    findByBranch: async (projectId: string, branch: string) => m.worksessions.find((w) => w.projectId === projectId && w.branch === branch) ?? null,
  },
}));
vi.mock('../worksessions/service.js', () => ({
  worksessionService: {
    assertUsable: async (_project: unknown, id: string) => {
      const ws = m.worksessions.find((w) => w.id === id);
      if (!ws) throw new Error('Work session introuvable');
      return ws;
    },
    create: async (projectId: string, input: { branch: string }) => {
      const ws = { id: `ws-${input.branch}`, projectId, branch: input.branch, taskId: null, archivedAt: null };
      m.worksessions.push(ws);
      m.createdWorksessions.push(input);
      return ws;
    },
    delete: async (id: string) => {
      m.deletedWorksessions.push(id);
      return true;
    },
  },
}));
vi.mock('../tasks/repository.js', () => ({
  taskRepository: {
    findById: async (id: string) => m.tasks.find((t) => t.id === id) ?? null,
    findForBranches: async (keys: Array<{ projectId: string; branch: string }>) =>
      new Map(m.tasks.filter((t) => keys.some((k) => k.projectId === t.projectId && k.branch === t.branch)).map((t) => [`${t.projectId}\u0000${t.branch}`, t])),
  },
}));
vi.mock('../tasks/service.js', () => ({
  taskService: {
    addComment: async (taskId: string, body: string) => {
      m.comments.push({ taskId, body });
      return { id: `c${m.comments.length}` };
    },
  },
}));
vi.mock('../sessions/repository.js', () => ({
  sessionRepository: {
    list: async (f: { worksessionId?: string }) => m.sessions.filter((s) => !f.worksessionId || s.worksessionId === f.worksessionId),
    findById: async (id: string) => m.sessions.find((s) => s.id === id) ?? null,
    findLastEvent: async () => (m.lastResult ? { id: '1', sessionId: 's', type: 'claude.result', payload: m.lastResult, createdAt: new Date() } : null),
    update: async (id: string, patch: Partial<Session>) => {
      const s = m.sessions.find((x) => x.id === id);
      if (!s) return null;
      Object.assign(s, patch);
      return s;
    },
  },
}));
vi.mock('../sessions/service.js', () => ({
  sessionService: {
    create: async (input: Record<string, unknown>) => {
      m.created.push(input);
      return { id: 'review-1', ...input };
    },
    isRunning: (id: string) => m.running.has(id),
    end: async (id: string) => {
      m.ended.push(id);
    },
  },
}));

const { reviewService, reviewPrompt, INLINE_DIFF_CHARS } = await import('./service.js');

const diff = (patch = 'diff --git a/x.ts b/x.ts\n+const a = 1;\n') => ({ branch: 'feature', baseBranch: 'origin/main', mergeBase: 'abc1234def', commits: 2, stat: ' x.ts | 1 +\n', patch });

const reviewSession = (review: Partial<SessionReview> = {}, over: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    projectId: 'p',
    name: 'Relecture feature',
    status: 'running',
    activity: 'idle',
    error: null,
    worksessionId: 'ws1',
    config: { permissionMode: 'dontAsk', review: { branch: 'feature', baseBranch: 'origin/main', mergeBase: 'abc', commits: 2, pullRequestId: null, prNumber: null, prUrl: null, taskId: 't1', requestedBy: 'u1', ...review } },
    ...over,
  }) as Session;

beforeEach(() => {
  m.worksessions = [{ id: 'ws1', projectId: 'p', branch: 'feature', taskId: null, archivedAt: null }];
  m.sessions = [];
  m.prs = [];
  m.tasks = [{ id: 't1', projectId: 'p', title: 'Nouvelle fonction', description: 'Faire X', branch: 'feature' }];
  m.diff = diff();
  m.created = [];
  m.createdWorksessions = [];
  m.deletedWorksessions = [];
  m.comments = [];
  m.githubComments = [];
  m.githubFails = false;
  m.lastResult = null;
  m.ended = [];
  m.running = new Set();
});

describe('reviewService.request', () => {
  it('lance une session Claude en lecture seule dans le dossier de la branche, diff dans la consigne', async () => {
    await reviewService.request({ projectId: 'p', worksessionId: 'ws1' }, 'u1');
    expect(m.created).toHaveLength(1);
    const input = m.created[0] as { worksessionId: string; provider: string; ownerId: string; prompt: string; attachments: unknown[]; config: { permissionMode: string; review: SessionReview } };
    expect(input).toMatchObject({ worksessionId: 'ws1', provider: 'claude', ownerId: 'u1', name: 'Relecture feature' });
    expect(input.config.permissionMode).toBe('dontAsk');
    expect(input.config.review).toMatchObject({ branch: 'feature', baseBranch: 'origin/main', commits: 2, taskId: 't1', requestedBy: 'u1', pullRequestId: null });
    expect(input.prompt).toContain('+const a = 1;');
    expect(input.prompt).toContain('Nouvelle fonction');
    expect(input.prompt).toContain('Sécurité');
    expect(input.attachments).toEqual([]);
  });

  it('rattache la PR ouverte de la branche', async () => {
    m.prs = [{ id: 'pr1', projectId: 'p', repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', title: 'Feature', headBranch: 'feature', baseBranch: 'main', status: 'open', taskId: null, worksessionId: 'ws1' }];
    await reviewService.request({ projectId: 'p', worksessionId: 'ws1' }, 'u1');
    expect((m.created[0] as { config: { review: SessionReview } }).config.review).toMatchObject({ pullRequestId: 'pr1', prNumber: 12 });
  });

  it('joint un long diff en fichier plutôt que dans la consigne', async () => {
    m.diff = diff(`diff --git a/x b/x\n${'+ligne\n'.repeat(INLINE_DIFF_CHARS / 6 + 10)}`);
    await reviewService.request({ projectId: 'p', worksessionId: 'ws1' }, 'u1');
    const input = m.created[0] as { prompt: string; attachments: Array<{ name: string; mediaType: string; data: string }> };
    expect(input.attachments).toHaveLength(1);
    expect(input.attachments[0]).toMatchObject({ name: 'feature.diff', mediaType: 'text/x-diff' });
    expect(Buffer.from(input.attachments[0].data, 'base64').toString()).toBe(m.diff!.patch);
    expect(input.prompt).not.toContain('+ligne');
    expect(input.prompt).toContain('fichier joint');
  });

  it('refuse une branche sans modification, et une deuxième relecture en cours', async () => {
    m.diff = diff('');
    await expect(reviewService.request({ projectId: 'p', worksessionId: 'ws1' }, 'u1')).rejects.toThrow(/Rien à relire/);
    m.diff = diff();
    m.sessions = [reviewSession({ reportedAt: null }, { status: 'running', activity: 'busy' })];
    await expect(reviewService.request({ projectId: 'p', worksessionId: 'ws1' }, 'u1')).rejects.toThrow(/déjà en cours/);
  });

  it("PR sans dossier de travail : en crée un sur sa branche, supprimé si le lancement échoue ; refuse un autre dépôt", async () => {
    m.prs = [{ id: 'pr2', projectId: 'p', repo: 'acme/app', number: 20, url: 'u', title: 'Autre', headBranch: 'autre', baseBranch: 'main', status: 'open', taskId: 't1', worksessionId: null }];
    await reviewService.request({ projectId: 'p', pullRequestId: 'pr2' }, 'u1');
    expect(m.createdWorksessions).toEqual([{ branch: 'autre' }]);
    expect(m.created[0]).toMatchObject({ worksessionId: 'ws-autre', name: 'Relecture PR #20' });

    m.worksessions = m.worksessions.filter((w) => w.id !== 'ws-autre');
    m.diff = null;
    await expect(reviewService.request({ projectId: 'p', pullRequestId: 'pr2' }, 'u1')).rejects.toThrow(/branche de base/);
    expect(m.deletedWorksessions).toEqual(['ws-autre']);

    m.prs.push({ id: 'pr3', projectId: 'p', repo: 'other/lib', number: 3, url: 'u', title: 'Lib', headBranch: 'x', baseBranch: 'main', status: 'open', taskId: null, worksessionId: null });
    await expect(reviewService.request({ projectId: 'p', pullRequestId: 'pr3' }, 'u1')).rejects.toThrow(/autre dépôt/);
  });
});

describe('reviewService.report', () => {
  it("publie le rapport dans le fil de la tâche et sur la PR, le range dans la session, puis termine la session", async () => {
    m.prs = [{ id: 'pr1', projectId: 'p', repo: 'acme/app', number: 12, url: 'u', title: 'Feature', headBranch: 'feature', baseBranch: 'main', status: 'open', taskId: 't1', worksessionId: 'ws1' }];
    m.sessions = [reviewSession({ pullRequestId: 'pr1', prNumber: 12 })];
    m.lastResult = { subtype: 'success', is_error: false, result: '✅ Rien de bloquant.\n\n- suggestion `x.ts:1`' };
    await reviewService.report('s1');
    expect(m.comments).toHaveLength(1);
    expect(m.comments[0].taskId).toBe('t1');
    expect(m.comments[0].body).toContain('✅ Rien de bloquant.');
    expect(m.comments[0].body).toContain('https://skipper.test/sessions/s1');
    expect(m.githubComments).toEqual([expect.objectContaining({ number: 12, userId: 'u1' })]);
    const review = reviewOf(m.sessions[0])!;
    expect(review.reportedAt).toBeTruthy();
    expect(review.report).toContain('Rien de bloquant');
    expect(review).toMatchObject({ taskCommentId: 'c1', githubCommentUrl: 'https://github.com/acme/app/pull/12#issuecomment-1', error: null });
    expect(m.ended).toEqual(['s1']);

    // Une seule publication : les tours suivants (discussion avec l'agent) ne republient rien.
    await reviewService.report('s1');
    expect(m.comments).toHaveLength(1);
  });

  it("n'agit pas tant que le premier tour n'est pas fini", async () => {
    m.sessions = [reviewSession({}, { activity: 'busy' })];
    m.lastResult = { subtype: 'success', is_error: false, result: 'rapport' };
    await reviewService.report('s1');
    expect(m.comments).toHaveLength(0);
    expect(reviewOf(m.sessions[0])!.reportedAt).toBeUndefined();
  });

  it("signale l'échec dans le fil de la tâche, sans commentaire GitHub", async () => {
    m.sessions = [reviewSession({ pullRequestId: 'pr1', prNumber: 12 }, { status: 'failed', activity: null, error: 'Processus tué' })];
    await reviewService.report('s1');
    expect(m.comments[0].body).toMatch(/n'a pas abouti \(Processus tué\)/);
    expect(m.githubComments).toHaveLength(0);
    expect(reviewOf(m.sessions[0])).toMatchObject({ error: 'Processus tué', report: null });
  });

  it("garde l'erreur GitHub sans empêcher le commentaire de tâche", async () => {
    m.prs = [{ id: 'pr1', projectId: 'p', repo: 'acme/app', number: 12, url: 'u', title: 'Feature', headBranch: 'feature', baseBranch: 'main', status: 'open', taskId: 't1', worksessionId: 'ws1' }];
    m.sessions = [reviewSession({ pullRequestId: 'pr1', prNumber: 12 })];
    m.lastResult = { subtype: 'success', is_error: false, result: 'rapport' };
    m.githubFails = true;
    await reviewService.report('s1');
    expect(m.comments).toHaveLength(1);
    expect(reviewOf(m.sessions[0])!.githubError).toBe('GitHub non connecté');
  });
});

describe('reviewPrompt', () => {
  it('donne la grille, le format du rapport et le diff ou le renvoi au fichier joint', () => {
    const review = { branch: 'feature', baseBranch: 'origin/main', mergeBase: 'abc1234def', commits: 2 } as SessionReview;
    const inline = reviewPrompt({ review, task: null, pr: { number: 7, title: 'T', url: 'https://x/7' }, stat: ' a | 1 +', patch: '+x' });
    expect(inline).toContain('#7 « T »');
    expect(inline).toContain('```diff\n+x\n```');
    expect(inline).toMatch(/Bugs et régressions/);
    expect(inline).toMatch(/verdict/);
    expect(reviewPrompt({ review, task: null, pr: null, stat: '', patch: null })).toContain('fichier joint');
  });
});
