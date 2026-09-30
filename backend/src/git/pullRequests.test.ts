import { beforeEach, describe, expect, it, vi } from 'vitest';

// Base, git et GitHub sont simulés : on vérifie l'enchaînement fusion → nettoyage.
const m = vi.hoisted(() => ({
  git: vi.fn(async (_args: string[], _cwd?: string): Promise<string> => ''),
  worktrees: [] as Array<{ id: string; projectId: string; name: string; branch: string }>,
  running: [] as Array<{ id: string }>,
  tasks: [] as Array<{ id: string; projectId: string; title: string; status: string; branch: string | null }>,
  stop: vi.fn(async () => undefined),
  deleteWorktree: vi.fn(async () => true),
  updateTask: vi.fn(async () => undefined),
  fetch: vi.fn(),
}));

vi.mock('../projects/service.js', () => ({ projectService: { get: async (id: string) => ({ id, slug: id, gitUrl: 'https://github.com/acme/app.git', gitBranch: 'main' }) } }));
vi.mock('../projects/workspace.js', () => ({ git: m.git, workspacePath: () => '/ws/main' }));
vi.mock('../files/service.js', () => ({ resolveRoot: async () => '/ws/wt' }));
vi.mock('../settings/github.js', () => ({ githubService: { token: async () => 'ghp_test' } }));
vi.mock('./service.js', () => ({ gitService: { push: vi.fn(async () => '') } }));
vi.mock('../sessions/service.js', () => ({ sessionService: { list: async () => m.running, stop: m.stop } }));
vi.mock('../terminals/service.js', () => ({ terminalService: { listByProject: async () => [], delete: vi.fn() } }));
vi.mock('../worktrees/repository.js', () => ({ worktreeRepository: { listByProject: async () => m.worktrees } }));
vi.mock('../worktrees/service.js', () => ({ worktreeService: { delete: m.deleteWorktree } }));
vi.mock('../tasks/repository.js', () => ({ taskRepository: { list: async () => m.tasks } }));
vi.mock('../tasks/service.js', () => ({ taskService: { update: m.updateTask } }));
vi.stubGlobal('fetch', m.fetch);

const { buildDraftText, parseGithubRepo, pullRequestService } = await import('./pullRequests.js');

const gqlPr = (state = 'OPEN') => ({
  number: 7,
  title: 'Ma PR',
  body: '',
  url: 'https://github.com/acme/app/pull/7',
  state,
  isDraft: false,
  createdAt: '2026-09-30T10:00:00Z',
  updatedAt: '2026-09-30T10:00:00Z',
  mergedAt: null,
  closedAt: null,
  author: { login: 'stan', avatarUrl: '' },
  headRefName: 'task/ma-tache',
  baseRefName: 'main',
  isCrossRepository: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  commits: { totalCount: 1, nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null }] } } } }] },
  latestReviews: { nodes: [] },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parseGithubRepo', () => {
  it('reconnaît les URL https, ssh et les alias ssh', () => {
    expect(parseGithubRepo('https://github.com/stan-toolso/skipper.git')).toEqual({ owner: 'stan-toolso', name: 'skipper' });
    expect(parseGithubRepo('https://github.com/stan-toolso/skipper')).toEqual({ owner: 'stan-toolso', name: 'skipper' });
    expect(parseGithubRepo('git@github.com:acme/app.git')).toEqual({ owner: 'acme', name: 'app' });
    expect(parseGithubRepo('git@github-curso:stan-toolso/Curso.git')).toEqual({ owner: 'stan-toolso', name: 'Curso' });
    expect(parseGithubRepo('ssh://git@github.com/acme/app.git')).toEqual({ owner: 'acme', name: 'app' });
  });
  it('refuse les autres hébergeurs', () => {
    expect(parseGithubRepo('https://gitlab.com/acme/app.git')).toBeNull();
    expect(parseGithubRepo(null)).toBeNull();
  });
});

describe('buildDraftText', () => {
  it('prend le titre de la tâche et liste les commits du plus ancien au plus récent', () => {
    const d = buildDraftText('task/x', [{ subject: 'deux' }, { subject: 'un' }], 'Ma tâche');
    expect(d.title).toBe('Ma tâche');
    expect(d.body).toBe('Tâche : Ma tâche\n\n## Commits\n\n- un\n- deux');
  });
  it('sans tâche : commit unique, sinon nom de branche', () => {
    expect(buildDraftText('feat/a', [{ subject: 'Ajoute A' }]).title).toBe('Ajoute A');
    expect(buildDraftText('task/pull-requests-github', [{ subject: 'a' }, { subject: 'b' }]).title).toBe('Pull requests github');
  });
});

describe('pullRequestService.merge', () => {
  beforeEach(() => {
    m.fetch.mockReset();
    m.git.mockClear();
    m.stop.mockClear();
    m.deleteWorktree.mockClear();
    m.updateTask.mockClear();
    m.worktrees = [{ id: 'wt1', projectId: 'p1', name: 'task-ma-tache', branch: 'task/ma-tache' }];
    m.running = [];
    m.tasks = [{ id: 't1', projectId: 'p1', title: 'Ma tâche', status: 'in_progress', branch: 'task/ma-tache' }];
    m.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/graphql')) return json({ data: { repository: { pullRequest: gqlPr(m.fetch.mock.calls.some(([, i]) => (i as RequestInit).method === 'PUT') ? 'MERGED' : 'OPEN') } } });
      if (init.method === 'PUT') return json({ sha: 'abc123', merged: true, message: 'ok' });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ message: 'inattendu' }, 500);
    });
  });

  it('fusionne en squash puis supprime branche distante, worktree et termine la tâche', async () => {
    const res = await pullRequestService.merge('p1', 7, 'SQUASH', { deleteRemoteBranch: true, deleteWorktree: true, completeTasks: true });
    const put = m.fetch.mock.calls.find(([, i]) => (i as RequestInit).method === 'PUT')!;
    expect(put[0]).toBe('https://api.github.com/repos/acme/app/pulls/7/merge');
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ merge_method: 'squash' });
    const del = m.fetch.mock.calls.find(([, i]) => (i as RequestInit).method === 'DELETE')!;
    expect(del[0]).toBe('https://api.github.com/repos/acme/app/git/refs/heads/task/ma-tache');
    expect(m.deleteWorktree).toHaveBeenCalledWith('wt1', true);
    expect(m.updateTask).toHaveBeenCalledWith('t1', { status: 'done' });
    expect(res).toMatchObject({ sha: 'abc123', deletedWorktreeIds: ['wt1'], completedTaskIds: ['t1'], warnings: [] });
    expect(res.pullRequest.state).toBe('MERGED');
  });

  it('conserve le worktree si des sessions y tournent, sauf demande de les arrêter', async () => {
    m.running = [{ id: 's1' }];
    const kept = await pullRequestService.merge('p1', 7, 'MERGE', { deleteWorktree: true });
    expect(m.deleteWorktree).not.toHaveBeenCalled();
    expect(kept.warnings[0]).toMatch(/task-ma-tache conservé/);
    m.fetch.mockClear(); // la PR redevient ouverte pour la seconde fusion

    const removed = await pullRequestService.merge('p1', 7, 'MERGE', { deleteWorktree: true, stopSessions: true });
    expect(m.stop).toHaveBeenCalledWith('s1');
    expect(removed.deletedWorktreeIds).toEqual(['wt1']);
  });

  it('traduit un refus de fusion de GitHub', async () => {
    m.fetch.mockImplementation(async (url: string, init: RequestInit) =>
      url.endsWith('/graphql') ? json({ data: { repository: { pullRequest: gqlPr() } } }) : init.method === 'PUT' ? json({ message: 'Pull Request is not mergeable' }, 405) : json({}, 500),
    );
    await expect(pullRequestService.merge('p1', 7)).rejects.toThrow(/Fusion refusée par GitHub : Pull Request is not mergeable/);
  });
});
