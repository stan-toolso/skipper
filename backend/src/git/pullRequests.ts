import { AppError } from '../errors.js';
import { resolveRoot, type WorkspaceRef } from '../files/service.js';
import { projectService } from '../projects/service.js';
import { git, workspacePath } from '../projects/workspace.js';
import { sessionService } from '../sessions/service.js';
import { githubService } from '../settings/github.js';
import { taskRepository } from '../tasks/repository.js';
import { taskService } from '../tasks/service.js';
import { terminalService } from '../terminals/service.js';
import { worktreeRepository } from '../worktrees/repository.js';
import { worktreeService } from '../worktrees/service.js';
import { gitService } from './service.js';

/**
 * Pull requests GitHub d'un projet, avec le jeton de la connexion GitHub (Paramètres) : liste avec
 * l'état des checks, des revues et de la fusion (API GraphQL de GitHub, une requête), création et
 * fusion (API REST), puis nettoyage du worktree et des branches de la PR fusionnée.
 */

export interface GithubRepoRef {
  owner: string;
  name: string;
}

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';
export type PullRequestFilter = PullRequestState | 'ALL';
export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';

export interface PullRequestCheck {
  name: string;
  /** SUCCESS, FAILURE, PENDING, NEUTRAL, SKIPPED */
  state: string;
  url: string | null;
}

export interface PullRequestReview {
  author: string;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING */
  state: string;
}

export interface PullRequest {
  projectId: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: PullRequestState;
  isDraft: boolean;
  author: string | null;
  authorAvatarUrl: string | null;
  headRefName: string;
  baseRefName: string;
  /** Branche d'un fork : pas de nettoyage possible depuis le dépôt. */
  isCrossRepository: boolean;
  /** MERGEABLE, CONFLICTING, UNKNOWN (GitHub calcule en tâche de fond). */
  mergeable: string;
  /** CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN */
  mergeStateStatus: string;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, ou null (pas de revue exigée). */
  reviewDecision: string | null;
  /** État agrégé des checks du dernier commit : SUCCESS, FAILURE, PENDING, ERROR, EXPECTED, ou null. */
  checksState: string | null;
  checks: PullRequestCheck[];
  reviews: PullRequestReview[];
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  createdAt: Date;
  updatedAt: Date;
  mergedAt: Date | null;
  closedAt: Date | null;
}

export interface PullRequestDraft {
  branch: string;
  base: string;
  title: string;
  body: string;
  commits: { hash: string; subject: string }[];
  /** La branche n'a pas encore de branche distante : la création la poussera. */
  needsPush: boolean;
  /** PR ouverte existant déjà pour cette branche. */
  existing: PullRequest | null;
}

export interface MergeCleanup {
  deleteRemoteBranch?: boolean | null;
  deleteWorktree?: boolean | null;
  stopSessions?: boolean | null;
  completeTasks?: boolean | null;
}

export interface MergeResult {
  pullRequest: PullRequest;
  sha: string | null;
  deletedWorktreeIds: string[];
  completedTaskIds: string[];
  /** Étapes de nettoyage non réalisées, expliquées. */
  warnings: string[];
}

/** owner/nom d'un dépôt GitHub depuis son URL (https, ssh, alias ssh `github-xxx`). */
export function parseGithubRepo(url: string | null | undefined): GithubRepoRef | null {
  if (!url) return null;
  const u = url.trim();
  const m =
    u.match(/^https?:\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
    u.match(/^(?:ssh:\/\/)?git@github[\w.-]*(?::|\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], name: m[2] } : null;
}

/** Titre et description pré-remplis d'une PR : tâche liée à la branche, sinon commits. */
export function buildDraftText(branch: string, commits: { subject: string }[], taskTitle?: string | null): { title: string; body: string } {
  const title =
    taskTitle?.trim() ||
    (commits.length === 1 ? commits[0].subject : branch.replace(/^task\//, '').replace(/[-_/]+/g, ' ').replace(/^./, (c) => c.toUpperCase()));
  const lines: string[] = [];
  if (taskTitle) lines.push(`Tâche : ${taskTitle.trim()}`, '');
  if (commits.length) {
    lines.push('## Commits', '');
    // Du plus ancien au plus récent.
    for (const c of [...commits].reverse()) lines.push(`- ${c.subject}`);
  }
  return { title, body: lines.join('\n').trim() };
}

// --- Appels GitHub -----------------------------------------------------------

async function requireToken(): Promise<string> {
  const token = await githubService.token();
  if (!token) throw new AppError('GitHub non connecté : ajoutez un jeton dans Paramètres → GitHub');
  return token;
}

function githubErrorMessage(status: number, body: unknown): string {
  const b = body as { message?: string; errors?: Array<{ message?: string; code?: string; field?: string } | string> } | null;
  const details = (b?.errors ?? []).map((e) => (typeof e === 'string' ? e : e.message ?? [e.code, e.field].filter(Boolean).join(' '))).filter(Boolean);
  const msg = [b?.message, ...details].filter(Boolean).join(' : ');
  if (status === 401) return 'GitHub refuse le jeton (invalide, expiré ou révoqué)';
  if (status === 403 || status === 404) return `GitHub : accès refusé ou dépôt introuvable${msg ? ` (${msg})` : ''}. Le jeton doit avoir l'accès « Pull requests : Read and write » (ou la portée repo).`;
  return `GitHub (${status}) : ${msg || 'erreur inconnue'}`;
}

/** Erreur de l'API REST, avec son code HTTP. */
class RestError extends AppError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await requireToken();
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'skipper',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new RestError(res.status, githubErrorMessage(res.status, data));
  return data as T;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await requireToken();
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'skipper', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const data = (await res.json().catch(() => null)) as { data?: T; errors?: Array<{ message: string; type?: string }> } | null;
  if (!res.ok) throw new AppError(githubErrorMessage(res.status, data));
  if (data?.errors?.length) {
    if (data.errors.some((e) => e.type === 'NOT_FOUND')) throw new AppError(githubErrorMessage(404, { message: data.errors[0].message }));
    throw new AppError(`GitHub : ${data.errors.map((e) => e.message).join(' ; ')}`);
  }
  return data!.data as T;
}

const PR_FIELDS = `
  number title body url state isDraft createdAt updatedAt mergedAt closedAt
  author { login avatarUrl }
  headRefName baseRefName isCrossRepository
  mergeable mergeStateStatus reviewDecision
  additions deletions changedFiles
  commits(last: 1) {
    totalCount
    nodes { commit { statusCheckRollup { state contexts(first: 30) { nodes {
      __typename
      ... on CheckRun { name status conclusion detailsUrl }
      ... on StatusContext { context state targetUrl }
    } } } } }
  }
  latestReviews(first: 20) { nodes { author { login } state } }
`;

interface GqlPullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: PullRequestState;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  author: { login: string; avatarUrl: string } | null;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: {
    totalCount: number;
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: { nodes: Array<{ __typename: string; name?: string; status?: string; conclusion?: string | null; detailsUrl?: string | null; context?: string; state?: string; targetUrl?: string | null }> };
        } | null;
      };
    }>;
  };
  latestReviews: { nodes: Array<{ author: { login: string } | null; state: string }> };
}

function checkState(c: { __typename: string; status?: string; conclusion?: string | null; state?: string }): string {
  if (c.__typename === 'CheckRun') {
    if (c.status !== 'COMPLETED') return 'PENDING';
    switch (c.conclusion) {
      case 'SUCCESS':
        return 'SUCCESS';
      case 'NEUTRAL':
        return 'NEUTRAL';
      case 'SKIPPED':
        return 'SKIPPED';
      default:
        return 'FAILURE';
    }
  }
  if (c.state === 'SUCCESS') return 'SUCCESS';
  if (c.state === 'PENDING' || c.state === 'EXPECTED') return 'PENDING';
  return 'FAILURE';
}

function toPullRequest(projectId: string, p: GqlPullRequest): PullRequest {
  const rollup = p.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  return {
    projectId,
    number: p.number,
    title: p.title,
    body: p.body,
    url: p.url,
    state: p.state,
    isDraft: p.isDraft,
    author: p.author?.login ?? null,
    authorAvatarUrl: p.author?.avatarUrl ?? null,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    isCrossRepository: p.isCrossRepository,
    mergeable: p.mergeable,
    mergeStateStatus: p.mergeStateStatus,
    reviewDecision: p.reviewDecision,
    checksState: rollup?.state ?? null,
    checks: (rollup?.contexts.nodes ?? []).map((c) => ({ name: c.name ?? c.context ?? '?', state: checkState(c), url: c.detailsUrl ?? c.targetUrl ?? null })),
    reviews: p.latestReviews.nodes.map((r) => ({ author: r.author?.login ?? '?', state: r.state })),
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changedFiles,
    commitCount: p.commits.totalCount,
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.updatedAt),
    mergedAt: p.mergedAt ? new Date(p.mergedAt) : null,
    closedAt: p.closedAt ? new Date(p.closedAt) : null,
  };
}

// Cache court : le panneau git interroge régulièrement, et chaque carte de tâche cherche sa PR.
const CACHE_TTL_MS = 20_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}
function invalidate(repo: GithubRepoRef): void {
  const prefix = `${repo.owner}/${repo.name}|`.toLowerCase();
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}
const repoKey = (repo: GithubRepoRef, suffix: string) => `${repo.owner}/${repo.name}|${suffix}`.toLowerCase();

// --- Service -------------------------------------------------------------------

async function projectRepo(projectId: string): Promise<GithubRepoRef> {
  const project = await projectService.get(projectId);
  const repo = parseGithubRepo(project.gitUrl);
  if (!repo) throw new AppError(project.gitUrl ? "Le dépôt de ce projet n'est pas hébergé sur GitHub" : "Ce projet n'est pas relié à un dépôt git");
  return repo;
}

async function defaultBranch(repo: GithubRepoRef): Promise<string> {
  return cached(repoKey(repo, 'default'), async () => {
    const r = await rest<{ default_branch: string }>('GET', `/repos/${repo.owner}/${repo.name}`);
    return r.default_branch;
  });
}

function validateBranchName(branch: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch) || branch.includes('..')) throw new AppError(`Nom de branche invalide : ${branch}`);
  return branch;
}

async function currentBranch(cwd: string): Promise<string> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch === 'HEAD') throw new AppError('HEAD détaché : placez-vous sur une branche pour ouvrir une pull request');
  return branch;
}

export const pullRequestService = {
  isGithubProject: async (projectId: string) => Boolean(parseGithubRepo((await projectService.get(projectId)).gitUrl)),

  /** PR du dépôt du projet, les plus récemment mises à jour d'abord. */
  async list(projectId: string, filter: PullRequestFilter = 'OPEN', limit = 50): Promise<PullRequest[]> {
    const repo = await projectRepo(projectId);
    const states = filter === 'ALL' ? ['OPEN', 'CLOSED', 'MERGED'] : [filter];
    const first = Math.min(Math.max(limit, 1), 100);
    const nodes = await cached(repoKey(repo, `list:${states.join(',')}:${first}`), async () => {
      const data = await graphql<{ repository: { pullRequests: { nodes: GqlPullRequest[] } } }>(
        `query($owner: String!, $name: String!, $states: [PullRequestState!], $first: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequests(states: $states, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
          }
        }`,
        { owner: repo.owner, name: repo.name, states, first },
      );
      return data.repository.pullRequests.nodes;
    });
    return nodes.map((p) => toPullRequest(projectId, p));
  },

  async get(projectId: string, number: number): Promise<PullRequest> {
    const repo = await projectRepo(projectId);
    const data = await graphql<{ repository: { pullRequest: GqlPullRequest | null } }>(
      `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} } } }`,
      { owner: repo.owner, name: repo.name, number },
    );
    if (!data.repository.pullRequest) throw new AppError(`Pull request #${number} introuvable`);
    return toPullRequest(projectId, data.repository.pullRequest);
  },

  /**
   * PR la plus récente d'une branche (ouverte de préférence), parmi les 100 dernières du dépôt.
   * Null si le projet n'est pas sur GitHub ou si GitHub ne répond pas : sert à l'affichage des tâches.
   */
  async forBranch(projectId: string, branch: string): Promise<PullRequest | null> {
    try {
      const all = (await this.list(projectId, 'ALL', 100)).filter((p) => p.headRefName === branch && !p.isCrossRepository);
      return all.find((p) => p.state === 'OPEN') ?? all[0] ?? null;
    } catch {
      return null;
    }
  },

  /** Titre, description et base proposés pour une PR de la branche courante du workspace. */
  async draft(ref: WorkspaceRef): Promise<PullRequestDraft> {
    const repo = await projectRepo(ref.projectId);
    const project = await projectService.get(ref.projectId);
    const cwd = await resolveRoot(ref);
    const branch = await currentBranch(cwd);
    const base = project.gitBranch || (await defaultBranch(repo));
    if (branch === base) throw new AppError(`Vous êtes sur la branche de base (${base}) : créez ou choisissez une autre branche`);
    await git(['fetch', 'origin', base], cwd).catch(() => undefined);
    const baseRef = (await git(['rev-parse', '--verify', '--quiet', `origin/${base}`], cwd).catch(() => '')) ? `origin/${base}` : base;
    const log = await git(['log', '--format=%H%x1f%s', `${baseRef}..HEAD`], cwd).catch(() => '');
    const commits = log
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, subject] = l.split('\u001f');
        return { hash, subject };
      });
    const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd).catch(() => '');
    const task = (await taskRepository.list({ projectId: ref.projectId, limit: 1000 })).find((t) => t.branch === branch);
    const { title, body } = buildDraftText(branch, commits, task?.title);
    const existing = (await this.list(ref.projectId, 'OPEN')).find((p) => p.headRefName === branch && !p.isCrossRepository) ?? null;
    return { branch, base, title, body, commits, needsPush: !upstream, existing };
  },

  /** Pousse la branche courante du workspace puis ouvre la PR. */
  async create(ref: WorkspaceRef, input: { title: string; body?: string | null; base?: string | null; draft?: boolean | null }): Promise<PullRequest> {
    const repo = await projectRepo(ref.projectId);
    const project = await projectService.get(ref.projectId);
    const title = input.title.trim();
    if (!title) throw new AppError('Le titre de la pull request est vide');
    const cwd = await resolveRoot(ref);
    const branch = await currentBranch(cwd);
    const base = validateBranchName(input.base?.trim() || project.gitBranch || (await defaultBranch(repo)));
    if (branch === base) throw new AppError('La branche et la base sont identiques');
    await gitService.push(ref);
    let created: { number: number };
    try {
      created = await rest<{ number: number }>('POST', `/repos/${repo.owner}/${repo.name}/pulls`, { title, head: branch, base, body: input.body ?? '', draft: Boolean(input.draft) });
    } catch (err) {
      if (err instanceof RestError && err.status === 422 && /already exists/i.test(err.message)) throw new AppError(`Une pull request est déjà ouverte pour la branche ${branch}`);
      if (err instanceof RestError && err.status === 422 && /No commits between/i.test(err.message)) throw new AppError(`Aucun commit entre ${base} et ${branch} : rien à proposer`);
      throw err;
    }
    invalidate(repo);
    return this.get(ref.projectId, created.number);
  },

  /**
   * Fusionne la PR, puis nettoie selon `cleanup` : branche distante, worktree(s) et branche locale de
   * la branche de la PR (sessions encore ouvertes arrêtées si `stopSessions`), tâches liées terminées.
   * Le checkout principal est ensuite mis à jour (fetch, et pull si sa branche est la base).
   */
  async merge(projectId: string, number: number, method: MergeMethod = 'MERGE', cleanup: MergeCleanup = {}): Promise<MergeResult> {
    const repo = await projectRepo(projectId);
    const pr = await this.get(projectId, number);
    if (pr.state !== 'OPEN') throw new AppError(`La pull request #${number} n'est pas ouverte`);
    if (pr.isDraft) throw new AppError('Pull request en brouillon : marquez-la prête pour la revue sur GitHub avant de la fusionner');
    let sha: string | null = null;
    try {
      const res = await rest<{ sha: string; merged: boolean; message: string }>('PUT', `/repos/${repo.owner}/${repo.name}/pulls/${number}/merge`, { merge_method: method.toLowerCase() });
      sha = res.sha;
    } catch (err) {
      if (err instanceof RestError && err.status === 405) throw new AppError(`Fusion refusée par GitHub : ${err.message.replace(/^GitHub \(405\) : /, '')}`);
      if (err instanceof RestError && err.status === 409) throw new AppError('La branche a changé pendant la fusion : rechargez et réessayez');
      throw err;
    }
    invalidate(repo);

    const warnings: string[] = [];
    const deletedWorktreeIds: string[] = [];
    const completedTaskIds: string[] = [];
    const branch = pr.headRefName;
    const project = await projectService.get(projectId);
    const main = workspacePath(project);

    if (cleanup.deleteRemoteBranch && !pr.isCrossRepository) {
      try {
        await rest('DELETE', `/repos/${repo.owner}/${repo.name}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      } catch (err) {
        // 422 : déjà supprimée (suppression automatique des branches activée sur le dépôt).
        if (!(err instanceof RestError && err.status === 422)) warnings.push(`Branche distante ${branch} conservée : ${(err as Error).message}`);
      }
    }

    if (cleanup.deleteWorktree && !pr.isCrossRepository) {
      const worktrees = (await worktreeRepository.listByProject(projectId)).filter((w) => w.branch === branch);
      for (const wt of worktrees) {
        try {
          const running = await sessionService.list({ worktreeId: wt.id, status: 'running', limit: 200 });
          if (running.length && cleanup.stopSessions) for (const s of running) await sessionService.stop(s.id).catch(() => undefined);
          else if (running.length) {
            warnings.push(`Worktree ${wt.name} conservé : ${running.length} session(s) y tournent encore`);
            continue;
          }
          // Les sessions sont conservées (historique de la tâche) ; les terminaux du worktree sont fermés.
          for (const t of (await terminalService.listByProject(projectId)).filter((t) => t.worktreeId === wt.id)) await terminalService.delete(t.id);
          await worktreeService.delete(wt.id, true);
          deletedWorktreeIds.push(wt.id);
        } catch (err) {
          warnings.push(`Worktree ${wt.name} conservé : ${(err as Error).message}`);
        }
      }
      // Branche locale sans worktree dans le checkout principal (sauf si c'est la branche extraite).
      if (worktrees.length === 0) {
        const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], main).catch(() => '');
        const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], main).catch(() => '');
        if (exists && current !== branch) await git(['branch', '-D', branch], main).catch((err) => warnings.push(`Branche locale ${branch} conservée : ${(err as Error).message}`));
        else if (exists) warnings.push(`Branche locale ${branch} conservée : c'est la branche extraite du dossier principal`);
      }
    }

    if (cleanup.completeTasks) {
      const tasks = (await taskRepository.list({ projectId, status: ['todo', 'in_progress'], limit: 1000 })).filter((t) => t.branch === branch);
      for (const t of tasks) {
        await taskService.update(t.id, { status: 'done' });
        completedTaskIds.push(t.id);
      }
    }

    // Met à jour le checkout principal : références distantes, et avance rapide si on est sur la base.
    await git(['fetch', '--prune', 'origin'], main).catch(() => undefined);
    const mainBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], main).catch(() => '');
    if (mainBranch === pr.baseRefName) {
      await git(['pull', '--ff-only'], main).catch((err) => warnings.push(`Dossier principal non mis à jour : ${(err as Error).message}`));
    }

    const merged = await this.get(projectId, number).catch(() => ({ ...pr, state: 'MERGED' as const, mergedAt: new Date() }));
    return { pullRequest: merged, sha, deletedWorktreeIds, completedTaskIds, warnings };
  },
};
