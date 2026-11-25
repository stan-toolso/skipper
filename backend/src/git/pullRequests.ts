import { AppError } from '../errors.js';
import { resolveRoot, type WorkspaceRef } from '../files/service.js';
import { removeWorksessionKeepingSessions } from '../projects/cleanup.js';
import { projectService } from '../projects/service.js';
import { git, gitAuthFor, workspacePath } from '../projects/workspace.js';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { sessionService } from '../sessions/service.js';
import { forgejoAccounts, forgejoPulls } from '../gitServer/forgejo.js';
import { hostedRepo } from '../gitServer/paths.js';
import { githubOwnerOf, githubService } from '../settings/github.js';
import { gitlabService, projectGitlabRepo, refreshKnownGitlabHosts } from '../settings/gitlab.js';
import { gitlabMergeRequests, type GitlabTarget } from './gitlabMergeRequests.js';
import { userService } from '../users/service.js';
import { taskRepository } from '../tasks/repository.js';
import { taskService } from '../tasks/service.js';
import { worksessionRepository } from '../worksessions/repository.js';
import { gitService } from './service.js';

/**
 * Pull requests GitHub d'un projet, avec le jeton de la connexion GitHub (Paramètres) : liste avec
 * l'état des checks, des revues et de la fusion (API GraphQL de GitHub, une requête), création et
 * fusion (API REST), puis nettoyage de la work session et des branches de la PR fusionnée.
 * Un projet dont le dépôt est hébergé par Skipper a ses PR dans Forgejo (gitServer/forgejo.ts), au même format et avec
 * le même nettoyage : les actions y sont faites au nom de la personne qui agit (compte Forgejo, `sudo`). Les PR d'un
 * autre dépôt que celui du projet restent sur GitHub.
 * Un projet dont le dépôt est sur GitLab (gitlab.com ou une instance où un compte est connecté) a ses merge requests
 * au même format (git/gitlabMergeRequests.ts), avec le jeton du compte GitLab de la personne qui agit.
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
  /** Dépôt GitHub « owner/name » de la PR (celui du projet, ou un autre). */
  repo: string;
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
  /** Forge de la PR quand elle n'est pas déduite de son URL (merge request GitLab). */
  forge?: 'gitlab';
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
  deleteWorksession?: boolean | null;
  stopSessions?: boolean | null;
  completeTasks?: boolean | null;
}

export { ciVerdict, describeCi, type CiStatus, type CiVerdict } from './ci.js';
import type { CiStatus } from './ci.js';

export interface MergeResult {
  pullRequest: PullRequest;
  sha: string | null;
  deletedWorksessionIds: string[];
  completedTaskIds: string[];
  /** Étapes de nettoyage non réalisées, expliquées. */
  warnings: string[];
}

/** « owner/name » d'un dépôt. */
export const repoFullName = (repo: GithubRepoRef): string => `${repo.owner}/${repo.name}`;

/** Dépôt depuis un « owner/name » (ou une URL GitHub) ; null si la forme n'est pas reconnue. */
export function parseRepoFullName(text: string | null | undefined): GithubRepoRef | null {
  if (!text) return null;
  const t = text.trim();
  const m = t.match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  return m ? { owner: m[1], name: m[2] } : parseGithubRepo(t);
}

/** Dépôt GitHub du remote `origin` d'un dossier git ; null sans remote ou hors GitHub. */
export async function remoteRepoOf(cwd: string): Promise<GithubRepoRef | null> {
  const url = await git(['remote', 'get-url', 'origin'], cwd).catch(() => '');
  return parseGithubRepo(url);
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

/** Jeton GitHub de la personne qui agit, pour un dépôt (compte qui le sert, sinon compte par défaut) ; par défaut celui du projet. */
async function requireToken(projectId: string, userId: string | null | undefined, repo?: GithubRepoRef | null): Promise<string> {
  const owner = repo ? repo.owner : githubOwnerOf((await projectService.get(projectId)).gitUrl);
  const token = await githubService.token(userId, owner);
  if (!token) throw new AppError('GitHub non connecté : connectez un compte dans Paramètres → GitHub', 'GITHUB_NOT_CONNECTED');
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

async function rest<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
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

async function graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
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

/** Checks d'un commit (état agrégé et détail), partagés par les PR et par `ciStatus`. */
const CHECK_ROLLUP = `statusCheckRollup { state contexts(first: 30) { nodes {
      __typename
      ... on CheckRun { name status conclusion detailsUrl }
      ... on StatusContext { context state targetUrl }
    } } }`;

const PR_FIELDS = `
  number title body url state isDraft createdAt updatedAt mergedAt closedAt
  author { login avatarUrl }
  headRefName baseRefName isCrossRepository
  mergeable mergeStateStatus reviewDecision
  additions deletions changedFiles
  commits(last: 1) {
    totalCount
    nodes { commit { ${CHECK_ROLLUP} } }
  }
  latestReviews(first: 20) { nodes { author { login } state } }
`;

type GqlRollup = {
  state: string;
  contexts: { nodes: Array<{ __typename: string; name?: string; status?: string; conclusion?: string | null; detailsUrl?: string | null; context?: string; state?: string; targetUrl?: string | null }> };
} | null;

/** Détail des checks d'un état agrégé GitHub. */
const checksOf = (rollup: GqlRollup): PullRequestCheck[] => (rollup?.contexts.nodes ?? []).map((c) => ({ name: c.name ?? c.context ?? '?', state: checkState(c), url: c.detailsUrl ?? c.targetUrl ?? null }));

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

function toPullRequest(projectId: string, repo: GithubRepoRef, p: GqlPullRequest): PullRequest {
  const rollup = p.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  return {
    projectId,
    repo: repoFullName(repo),
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
    checks: checksOf(rollup),
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
// Au-delà du cache court, l'affichage (sidebar, cartes de tâches) se contente de la dernière liste connue
// pendant qu'elle se rafraîchit en arrière-plan : la liste des 100 PR coûte 2 à 3 s à GitHub, et la sidebar
// l'interroge toutes les 60 s, donc toujours à froid avec le seul cache court.
export const STALE_TTL_MS = 10 * 60_000;
interface CacheEntry {
  at: number;
  value: Promise<unknown>;
  settled: boolean;
  refreshing?: boolean;
}
const cache = new Map<string, CacheEntry>();
/** `fresh` : relit sans attendre l'expiration, et le résultat remplace l'entrée du cache ; `stale` : voir STALE_TTL_MS. */
function cached<T>(key: string, load: () => Promise<T>, opts: { fresh?: boolean; stale?: boolean } = {}): Promise<T> {
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (!opts.fresh && hit && age < CACHE_TTL_MS) return hit.value as Promise<T>;
  if (!opts.fresh && hit && opts.stale && hit.settled && age < STALE_TTL_MS) {
    if (!hit.refreshing) {
      hit.refreshing = true;
      load().then(
        (v) => {
          // Pas d'écrasement si l'entrée a été invalidée ou remplacée entre-temps.
          if (cache.get(key) === hit) cache.set(key, { at: Date.now(), value: Promise.resolve(v), settled: true });
        },
        () => {
          hit.refreshing = false;
        },
      );
    }
    return hit.value as Promise<T>;
  }
  // Relecture forcée (synchronisation) d'une liste déjà connue : l'ancienne reste servie aux lecteurs qui acceptent une
  // liste un peu ancienne jusqu'à l'arrivée de la nouvelle, au lieu de les faire tous attendre GitHub (2 à 4 s).
  if (opts.fresh && hit?.settled) {
    hit.refreshing = true;
    const value = load();
    value.then(
      (v) => {
        if (cache.get(key) === hit) cache.set(key, { at: Date.now(), value: Promise.resolve(v), settled: true });
      },
      () => {
        hit.refreshing = false;
      },
    );
    return value;
  }
  const value = load();
  const entry: CacheEntry = { at: Date.now(), value, settled: false };
  cache.set(key, entry);
  value.then(
    () => {
      entry.settled = true;
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  return value;
}
/** Pour les tests : vide le cache GitHub. */
export function clearPullRequestCache(): void {
  cache.clear();
}
function invalidate(repo: GithubRepoRef): void {
  const prefix = `${repo.owner}/${repo.name}|`.toLowerCase();
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}
const repoKey = (repo: GithubRepoRef, suffix: string) => `${repo.owner}/${repo.name}|${suffix}`.toLowerCase();

// --- Service -------------------------------------------------------------------

/** « owner/name » d'un chemin de projet GitLab (« groupe/sous-groupe/projet » : owner « groupe/sous-groupe »). */
export function gitlabRepoRef(path: string): GithubRepoRef {
  const i = path.lastIndexOf('/');
  return { owner: path.slice(0, i), name: path.slice(i + 1) };
}

function repoOf(project: { gitUrl: string | null; gitHosted?: boolean; slug?: string }): GithubRepoRef {
  if (project.gitHosted && project.slug) return hostedRepo(project.slug);
  const repo = parseGithubRepo(project.gitUrl);
  if (repo) return repo;
  const gitlab = project.gitHosted ? null : projectGitlabRepo(project.gitUrl);
  if (gitlab) return gitlabRepoRef(gitlab.path);
  throw new AppError(project.gitUrl ? "Le dépôt de ce projet n'est hébergé ni sur GitHub ni sur GitLab" : "Ce projet n'est pas relié à un dépôt git");
}

const projectRepo = async (projectId: string): Promise<GithubRepoRef> => {
  await refreshKnownGitlabHosts();
  return repoOf(await projectService.get(projectId));
};

/** Dépôt GitLab du projet (gitlab.com ou instance connue), null sinon ; jamais celui d'un autre dépôt (`repoRef`) ni d'un projet hébergé. */
async function onGitlab(projectId: string, repoRef?: GithubRepoRef | null): Promise<{ host: string; namespace: string; path: string } | null> {
  if (repoRef) return null;
  const project = await projectService.get(projectId);
  if (project.gitHosted || parseGithubRepo(project.gitUrl)) return null;
  await refreshKnownGitlabHosts();
  return projectGitlabRepo(project.gitUrl);
}

/** Projet GitLab visé avec le jeton de la personne qui agit (compte de l'instance qui sert l'espace du dépôt). */
async function gitlabTarget(repo: { host: string; namespace: string; path: string }, userId: string | null | undefined): Promise<GitlabTarget> {
  const token = await gitlabService.apiToken(userId, repo.host, repo.namespace);
  if (!token) throw new AppError(`GitLab non connecté : connectez un compte ${repo.host} dans Paramètres → GitLab`, 'GITLAB_NOT_CONNECTED');
  return { host: repo.host, path: repo.path, token };
}

/** Les PR de ce dépôt sont-elles dans Forgejo ? Celles du projet hébergé ; jamais celles d'un autre dépôt (`repoRef`). */
async function onForgejo(projectId: string, repoRef?: GithubRepoRef | null): Promise<boolean> {
  if (repoRef) return false;
  return Boolean((await projectService.get(projectId)).gitHosted);
}

/** Compte Forgejo de la personne qui agit (créé au besoin), au nom duquel la PR est ouverte ou fusionnée ; null : l'administrateur. */
async function forgejoActor(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  return forgejoAccounts.ensure(await userService.get(userId));
}

async function defaultBranch(repo: GithubRepoRef, token: string): Promise<string> {
  return cached(repoKey(repo, 'default'), async () => {
    const r = await rest<{ default_branch: string }>(token, 'GET', `/repos/${repo.owner}/${repo.name}`);
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
  /** Le projet a-t-il des pull requests (dépôt GitHub ou GitLab, ou dépôt hébergé dans Forgejo) ? */
  hasPullRequests: async (projectId: string) => {
    const project = await projectService.get(projectId);
    return project.gitHosted || Boolean(parseGithubRepo(project.gitUrl)) || Boolean(await onGitlab(projectId));
  },

  /**
   * PR d'un dépôt (celui du projet, ou `opts.repo`), les plus récemment mises à jour d'abord. `userId` : personne qui
   * consulte, dont le compte GitHub interroge le dépôt ; `opts.fresh` : sans le cache de 20 s ; `opts.stale` : accepte la
   * dernière liste connue (jusqu'à STALE_TTL_MS) pendant son rafraîchissement, pour l'affichage.
   */
  async list(projectId: string, userId: string | null | undefined, filter: PullRequestFilter = 'OPEN', limit = 50, opts: { fresh?: boolean; stale?: boolean; repo?: GithubRepoRef | null } = {}): Promise<PullRequest[]> {
    const repoRef = opts.repo ?? null;
    let repo = repoRef;
    if (!repo) {
      const project = await projectService.get(projectId);
      // Projet sans dépôt : rien à lister, ce n'est pas une erreur (le panneau git interroge tous les projets).
      if (!project.gitUrl) return [];
      await refreshKnownGitlabHosts();
      repo = repoOf(project);
      const gl = await onGitlab(projectId);
      if (gl) {
        const target = await gitlabTarget(gl, userId);
        return cached(repoKey(repo, `gitlab:list:${filter}:${limit}:${userId ?? ''}`), () => gitlabMergeRequests.list(projectId, target, filter, limit), opts);
      }
      if (project.gitHosted) {
        const fjRepo = repo;
        return cached(repoKey(fjRepo, `forgejo:list:${filter}:${limit}`), () => forgejoPulls.list(projectId, fjRepo, filter, Math.min(Math.max(limit, 1), 100)), opts);
      }
    }
    const token = await requireToken(projectId, userId, repoRef);
    const states = filter === 'ALL' ? ['OPEN', 'CLOSED', 'MERGED'] : [filter];
    const first = Math.min(Math.max(limit, 1), 100);
    const nodes = await cached(repoKey(repo, `list:${states.join(',')}:${first}:${userId ?? ''}`), async () => {
      const data = await graphql<{ repository: { pullRequests: { nodes: GqlPullRequest[] } } }>(
        token,
        `query($owner: String!, $name: String!, $states: [PullRequestState!], $first: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequests(states: $states, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
          }
        }`,
        { owner: repo.owner, name: repo.name, states, first },
      );
      return data.repository.pullRequests.nodes;
    }, opts);
    const r = repo;
    return nodes.map((p) => toPullRequest(projectId, r, p));
  },

  /** Une PR du dépôt du projet, ou de `repo` (un autre dépôt GitHub, lu avec le compte de la personne qui le sert). */
  async get(projectId: string, userId: string | null | undefined, number: number, repoRef?: GithubRepoRef | null): Promise<PullRequest> {
    const repo = repoRef ?? (await projectRepo(projectId));
    if (await onForgejo(projectId, repoRef)) return forgejoPulls.get(projectId, repo, number);
    const gl = await onGitlab(projectId, repoRef);
    if (gl) return gitlabMergeRequests.get(projectId, await gitlabTarget(gl, userId), number);
    const token = await requireToken(projectId, userId, repoRef);
    const data = await graphql<{ repository: { pullRequest: GqlPullRequest | null } }>(
      token,
      `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} } } }`,
      { owner: repo.owner, name: repo.name, number },
    );
    if (!data.repository.pullRequest) throw new AppError(`Pull request #${number} introuvable dans ${repoFullName(repo)}`);
    return toPullRequest(projectId, repo, data.repository.pullRequest);
  },

  /**
   * PR la plus récente d'une branche (ouverte de préférence), parmi les 100 dernières du dépôt.
   * Null si le projet n'est pas sur GitHub ou si GitHub ne répond pas : sert à l'affichage des tâches et de la sidebar,
   * qui se contente d'une liste un peu ancienne (rafraîchie en arrière-plan) plutôt que d'attendre GitHub à chaque relevé.
   */
  async forBranch(projectId: string, userId: string | null | undefined, branch: string): Promise<PullRequest | null> {
    try {
      const all = (await this.list(projectId, userId, 'ALL', 100, { stale: true })).filter((p) => p.headRefName === branch && !p.isCrossRepository);
      return all.find((p) => p.state === 'OPEN') ?? all[0] ?? null;
    } catch {
      return null;
    }
  },

  /** Titre, description et base proposés pour une PR de la branche courante du workspace. */
  async draft(ref: WorkspaceRef, userId: string | null | undefined): Promise<PullRequestDraft> {
    const repo = await projectRepo(ref.projectId);
    const project = await projectService.get(ref.projectId);
    const cwd = await resolveRoot(ref);
    const branch = await currentBranch(cwd);
    const gl = await onGitlab(ref.projectId);
    const base =
      project.gitBranch ||
      (project.gitHosted ? await forgejoPulls.defaultBranch(repo) : gl ? await gitlabMergeRequests.defaultBranch(await gitlabTarget(gl, userId)) : await defaultBranch(repo, await requireToken(ref.projectId, userId)));
    if (branch === base) throw new AppError(`Vous êtes sur la branche de base (${base}) : créez ou choisissez une autre branche`);
    await git(['fetch', 'origin', base], cwd, await gitAuthFor(project, userId)).catch(() => undefined);
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
    const existing = (await this.list(ref.projectId, userId, 'OPEN')).find((p) => p.headRefName === branch && !p.isCrossRepository) ?? null;
    return { branch, base, title, body, commits, needsPush: !upstream, existing };
  },

  /**
   * Pousse la branche courante du workspace puis ouvre la PR. Avec `path` (sous-dossier du dossier de travail
   * contenant un autre clone), la PR est ouverte sur le dépôt GitHub du remote `origin` de ce clone, avec le compte
   * de la personne qui sert ce dépôt.
   */
  async create(ref: WorkspaceRef, userId: string | null | undefined, input: { title: string; body?: string | null; base?: string | null; draft?: boolean | null; path?: string | null }): Promise<PullRequest> {
    const project = await projectService.get(ref.projectId);
    const title = input.title.trim();
    if (!title) throw new AppError('Le titre de la pull request est vide');
    const root = await resolveRoot(ref);
    const sub = input.path?.trim().replace(/^\/+|\/+$/g, '') ?? '';
    let cwd = root;
    let repo: GithubRepoRef;
    if (sub && sub !== '.') {
      cwd = await realpath(path.join(root, sub)).catch(() => {
        throw new AppError(`Dossier introuvable : ${sub}`);
      });
      if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new AppError('Le dossier doit être dans le dossier de travail');
      const remote = await remoteRepoOf(cwd);
      if (!remote) throw new AppError(`Le dossier ${sub} n'a pas de remote origin sur GitHub`);
      repo = remote;
    } else {
      // Dépôt GitLab du projet : la merge request est ouverte sur GitLab, avec le compte de la personne qui agit.
      const gl = await onGitlab(ref.projectId);
      if (gl) {
        const target = await gitlabTarget(gl, userId);
        const branch = await currentBranch(cwd);
        const base = validateBranchName(input.base?.trim() || project.gitBranch || (await gitlabMergeRequests.defaultBranch(target)));
        if (branch === base) throw new AppError('La branche et la base sont identiques');
        await gitService.push(ref, userId);
        const iid = await gitlabMergeRequests.create(target, { title, head: branch, base, body: input.body ?? '', draft: Boolean(input.draft) });
        invalidate(gitlabRepoRef(gl.path));
        return this.get(ref.projectId, userId, iid);
      }
      repo = (await remoteRepoOf(cwd)) ?? repoOf(project);
    }
    const projectRepoRef = project.gitHosted ? hostedRepo(project.slug) : parseGithubRepo(project.gitUrl);
    const sameAsProject = Boolean(projectRepoRef && repoFullName(projectRepoRef).toLowerCase() === repoFullName(repo).toLowerCase());
    const branch = await currentBranch(cwd);
    // Dépôt hébergé : la PR est ouverte dans Forgejo, au nom de la personne qui agit.
    if (project.gitHosted && sameAsProject && cwd === root) {
      const base = validateBranchName(input.base?.trim() || project.gitBranch || (await forgejoPulls.defaultBranch(repo)));
      if (branch === base) throw new AppError('La branche et la base sont identiques');
      await gitService.push(ref, userId);
      const number = await forgejoPulls.create(repo, { title, head: branch, base, body: input.body ?? '', draft: Boolean(input.draft) }, await forgejoActor(userId));
      invalidate(repo);
      return this.get(ref.projectId, userId, number);
    }
    const token = await requireToken(ref.projectId, userId, sameAsProject ? null : repo);
    const base = validateBranchName(input.base?.trim() || (sameAsProject ? project.gitBranch : null) || (await defaultBranch(repo, token)));
    if (branch === base) throw new AppError('La branche et la base sont identiques');
    if (cwd === root) await gitService.push(ref, userId);
    else {
      const auth = await githubService.gitConfigArgs(userId, `https://github.com/${repoFullName(repo)}.git`);
      const hasUpstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd).then(() => true, () => false);
      await (hasUpstream ? git(['push'], cwd, auth) : git(['push', '-u', 'origin', branch], cwd, auth));
    }
    let created: { number: number };
    try {
      created = await rest<{ number: number }>(token, 'POST', `/repos/${repo.owner}/${repo.name}/pulls`, { title, head: branch, base, body: input.body ?? '', draft: Boolean(input.draft) });
    } catch (err) {
      if (err instanceof RestError && err.status === 422 && /already exists/i.test(err.message)) throw new AppError(`Une pull request est déjà ouverte pour la branche ${branch}`);
      if (err instanceof RestError && err.status === 422 && /No commits between/i.test(err.message)) throw new AppError(`Aucun commit entre ${base} et ${branch} : rien à proposer`);
      throw err;
    }
    invalidate(repo);
    return this.get(ref.projectId, userId, created.number, sameAsProject ? null : repo);
  },

  /**
   * CI d'une branche ou d'un commit du dépôt du projet (GitHub seulement) : même lecture des checks que les PR.
   * `ref` : nom de branche, SHA (abrégé accepté) ou toute expression git que GitHub sait résoudre.
   */
  async ciStatus(projectId: string, userId: string | null | undefined, ref: string): Promise<CiStatus> {
    const expr = ref.trim();
    if (!expr || !/^[A-Za-z0-9][A-Za-z0-9._\/~^-]*$/.test(expr) || expr.includes('..')) throw new AppError(`Référence invalide : ${ref}`);
    const project = await projectService.get(projectId);
    const repo = parseGithubRepo(project.gitUrl);
    if (!repo || project.gitHosted) throw new AppError("L'état de la CI n'est disponible que pour un dépôt GitHub");
    const token = await requireToken(projectId, userId);
    const data = await graphql<{ repository: { object: { oid?: string; statusCheckRollup?: GqlRollup } | null } }>(
      token,
      `query($owner: String!, $name: String!, $expr: String!) { repository(owner: $owner, name: $name) { object(expression: $expr) { ... on Commit { oid ${CHECK_ROLLUP} } } } }`,
      { owner: repo.owner, name: repo.name, expr },
    );
    const commit = data.repository.object;
    if (!commit?.oid) throw new AppError(`Branche ou commit introuvable dans ${repoFullName(repo)} : ${expr}`);
    const rollup = commit.statusCheckRollup ?? null;
    return { ref: expr, sha: commit.oid, state: rollup?.state ?? null, checks: checksOf(rollup) };
  },

  /** Poste un commentaire sur la PR (fil de conversation GitHub) avec le compte de la personne ; renvoie son URL. */
  async comment(projectId: string, userId: string | null | undefined, number: number, body: string, repoRef?: GithubRepoRef | null): Promise<string> {
    const gl = await onGitlab(projectId, repoRef);
    if (gl) return gitlabMergeRequests.comment(await gitlabTarget(gl, userId), number, body);
    const repo = repoRef ?? (await projectRepo(projectId));
    const token = await requireToken(projectId, userId, repoRef);
    const res = await rest<{ html_url: string }>(token, 'POST', `/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, { body });
    return res.html_url;
  },

  /** Ferme la PR sans la fusionner (GitHub, GitLab ou Forgejo) avec le compte de la personne ; la branche est gardée. */
  async close(projectId: string, userId: string | null | undefined, number: number, repoRef?: GithubRepoRef | null): Promise<PullRequest> {
    const repo = repoRef ?? (await projectRepo(projectId));
    const pr = await this.get(projectId, userId, number, repoRef);
    if (pr.state !== 'OPEN') throw new AppError(`La pull request #${number} n'est pas ouverte`);
    if (await onForgejo(projectId, repoRef)) await forgejoPulls.close(repo, number, await forgejoActor(userId));
    else {
      const gl = await onGitlab(projectId, repoRef);
      if (gl) await gitlabMergeRequests.close(await gitlabTarget(gl, userId), number);
      else await rest(await requireToken(projectId, userId, repoRef), 'PATCH', `/repos/${repo.owner}/${repo.name}/pulls/${number}`, { state: 'closed' });
    }
    invalidate(repo);
    return this.get(projectId, userId, number, repoRef).catch(() => ({ ...pr, state: 'CLOSED' as const }));
  },

  /**
   * Fusionne la PR, puis nettoie selon `cleanup` : branche distante, worksession(s) et branche locale de
   * la branche de la PR (sessions encore ouvertes arrêtées si `stopSessions`), tâches liées terminées.
   * Le checkout principal est ensuite mis à jour (fetch, et pull si sa branche est la base).
   */
  async merge(projectId: string, userId: string | null | undefined, number: number, method: MergeMethod = 'MERGE', cleanup: MergeCleanup = {}, repoRef?: GithubRepoRef | null): Promise<MergeResult> {
    const repo = repoRef ?? (await projectRepo(projectId));
    const forgejo = await onForgejo(projectId, repoRef);
    const gl = forgejo ? null : await onGitlab(projectId, repoRef);
    const gitlab = gl ? await gitlabTarget(gl, userId) : null;
    const token = forgejo || gitlab ? null : await requireToken(projectId, userId, repoRef);
    const pr = await this.get(projectId, userId, number, repoRef);
    const forgeName = forgejo ? 'Forgejo' : gitlab ? 'GitLab' : 'GitHub';
    if (pr.state !== 'OPEN') throw new AppError(`La pull request #${number} n'est pas ouverte`);
    if (pr.isDraft) throw new AppError(`Pull request en brouillon : marquez-la prête pour la revue sur ${forgeName} avant de la fusionner`);
    let sha: string | null = null;
    if (forgejo) {
      sha = await forgejoPulls.merge(repo, number, method, await forgejoActor(userId));
    } else if (gitlab) {
      sha = await gitlabMergeRequests.merge(gitlab, number, method);
    } else {
      try {
        const res = await rest<{ sha: string; merged: boolean; message: string }>(token!, 'PUT', `/repos/${repo.owner}/${repo.name}/pulls/${number}/merge`, { merge_method: method.toLowerCase() });
        sha = res.sha;
      } catch (err) {
        if (err instanceof RestError && err.status === 405) throw new AppError(`Fusion refusée par GitHub : ${err.message.replace(/^GitHub \(405\) : /, '')}`);
        if (err instanceof RestError && err.status === 409) throw new AppError('La branche a changé pendant la fusion : rechargez et réessayez');
        throw err;
      }
    }
    invalidate(repo);

    const warnings: string[] = [];
    const deletedWorksessionIds: string[] = [];
    const completedTaskIds: string[] = [];
    const branch = pr.headRefName;

    if (cleanup.deleteRemoteBranch && !pr.isCrossRepository) {
      try {
        if (forgejo) await forgejoPulls.deleteBranch(repo, branch);
        else if (gitlab) await gitlabMergeRequests.deleteBranch(gitlab, branch);
        else await rest(token!, 'DELETE', `/repos/${repo.owner}/${repo.name}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      } catch (err) {
        // 422 : déjà supprimée (suppression automatique des branches activée sur le dépôt).
        if (!(err instanceof RestError && err.status === 422)) warnings.push(`Branche distante ${branch} conservée : ${(err as Error).message}`);
      }
    }

    // PR d'un autre dépôt que celui du projet : ni dossier de travail, ni tâche, ni checkout principal à mettre à jour.
    if (repoRef) {
      const merged = await this.get(projectId, userId, number, repoRef).catch(() => ({ ...pr, state: 'MERGED' as const, mergedAt: new Date() }));
      return { pullRequest: merged, sha, deletedWorksessionIds, completedTaskIds, warnings };
    }
    const project = await projectService.get(projectId);
    const main = workspacePath(project);
    const auth = await gitAuthFor(project, userId);

    if (cleanup.deleteWorksession && !pr.isCrossRepository) {
      const worksessions = (await worksessionRepository.listByProject(projectId)).filter((w) => w.branch === branch);
      for (const wt of worksessions) {
        try {
          const running = await sessionService.list({ worksessionId: wt.id, status: 'running', limit: 200 });
          if (running.length && cleanup.stopSessions) for (const s of running) await sessionService.stop(s.id).catch(() => undefined);
          else if (running.length) {
            warnings.push(`Dossier de travail ${wt.name} conservé : ${running.length} session(s) y tournent encore`);
            continue;
          }
          // Les sessions sont archivées avec le souvenir de la work session (historique de la tâche) ; ses terminaux sont fermés.
          await removeWorksessionKeepingSessions(wt.id, { deleteBranch: true, stopSessions: Boolean(cleanup.stopSessions) });
          deletedWorksessionIds.push(wt.id);
        } catch (err) {
          warnings.push(`Dossier de travail ${wt.name} conservé : ${(err as Error).message}`);
        }
      }
      // Branche locale sans worksession dans le checkout principal (sauf si c'est la branche extraite).
      if (worksessions.length === 0) {
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
    await git(['fetch', '--prune', 'origin'], main, auth).catch(() => undefined);
    const mainBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], main).catch(() => '');
    if (mainBranch === pr.baseRefName) {
      await git(['pull', '--ff-only'], main, auth).catch((err) => warnings.push(`Dossier principal non mis à jour : ${(err as Error).message}`));
    }

    const merged = await this.get(projectId, userId, number).catch(() => ({ ...pr, state: 'MERGED' as const, mergedAt: new Date() }));
    return { pullRequest: merged, sha, deletedWorksessionIds, completedTaskIds, warnings };
  },
};
