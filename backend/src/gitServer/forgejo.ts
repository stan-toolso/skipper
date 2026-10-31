import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { config, forgejoConfigured } from '../config.js';
import { AppError } from '../errors.js';
import type { PullRequest, PullRequestFilter } from '../git/pullRequests.js';
import { log } from '../log.js';
import { decryptSecret, encryptSecret } from '../settings/crypto.js';
import { forgeAccountRepository } from './accounts.js';
import type { ProjectRole, User } from '../users/types.js';

const execFileAsync = promisify(execFile);

/**
 * Client de la forge Forgejo qui héberge les dépôts des projets « hébergés » : un compte par personne (créé à la
 * demande, sans mot de passe utilisable : on s'y connecte par sa session Skipper, voir httpRoute.ts), un dépôt privé
 * par projet dans l'organisation de Skipper, les membres du projet en collaborateurs (rôle Skipper → droit Forgejo),
 * un webhook d'organisation vers Skipper, et les pull requests au format de Skipper (`PullRequest`, comme GitHub).
 * Skipper parle à l'API avec un jeton administrateur ; une action faite pour une personne passe `sudo=<son compte>`,
 * pour qu'elle en soit l'autrice dans Forgejo.
 */

export class ForgejoError extends AppError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireForgejo(): void {
  if (!forgejoConfigured()) throw new AppError("L'hébergement de dépôts n'est pas configuré sur ce serveur (Forgejo : FORGEJO_URL, FORGEJO_TOKEN)");
}

interface ApiOptions {
  /** Compte Forgejo au nom duquel agir (administrateur sinon). */
  sudo?: string | null;
  query?: Record<string, string | number | boolean>;
}

/** Appel de l'API de Forgejo (adresse interne, jeton administrateur). Une erreur porte le code HTTP et le message de Forgejo. */
export async function forgejoApi<T>(method: string, apiPath: string, body?: unknown, opts: ApiOptions = {}): Promise<T> {
  requireForgejo();
  const url = new URL(`${config.forgejo.internalUrl}/api/v1${apiPath}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
  if (opts.sudo) url.searchParams.set('sudo', opts.sudo);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `token ${config.forgejo.token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  }).catch((err: Error) => {
    throw new AppError(`Forgejo injoignable (${config.forgejo.internalUrl}) : ${err.message}`);
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = (data as { message?: string } | null)?.message ?? (typeof data === 'string' ? data.slice(0, 200) : '');
    throw new ForgejoError(res.status, `Forgejo (${res.status}) : ${message || res.statusText}`);
  }
  return data as T;
}

const notFound = (err: unknown) => err instanceof ForgejoError && err.status === 404;

/**
 * En-tête d'authentification git des commandes du serveur sur un dépôt hébergé (jeton administrateur en mot de passe).
 * Même forme que celui des comptes GitHub (« AUTHORIZATION: basic … ») : `git()` le masque dans ses messages d'erreur.
 */
export function forgejoGitAuthArgs(): string[] {
  if (!forgejoConfigured()) return [];
  const basic = Buffer.from(`skipper:${config.forgejo.token}`).toString('base64');
  const args = ['-c', `http.${config.forgejo.internalUrl}/.extraheader=AUTHORIZATION: basic ${basic}`];
  // Depuis le serveur, l'adresse publique est réécrite vers l'adresse directe (sans nginx ni connexion par session).
  if (config.forgejo.internalUrl !== config.forgejo.url) args.push('-c', `url.${config.forgejo.internalUrl}/.insteadOf=${config.forgejo.url}/`);
  return args;
}

// --- Comptes -------------------------------------------------------------------

/** Noms que Forgejo réserve ou qui prêteraient à confusion. */
const RESERVED = new Set(['admin', 'api', 'assets', 'attachments', 'avatars', 'explore', 'ghost', 'help', 'install', 'issues', 'login', 'notifications', 'org', 'pulls', 'repo', 'skipper', 'user', 'swagger', 'actions', 'new', 'root', 'administrator']);

/** Nom de compte Forgejo dérivé d'une adresse e-mail : partie locale, minuscules, lettres, chiffres, - _ . (40 au plus). */
export function forgeUsernameFromEmail(email: string): string {
  const local = email.split('@')[0].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let name = local.replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[._-]{2,}/g, '-').slice(0, 40);
  if (!name) name = 'membre';
  return RESERVED.has(name) ? `${name}-1` : name;
}

const ensuring = new Map<string, Promise<string>>();

export const forgejoAccounts = {
  /** Compte Forgejo déjà associé à une personne, ou null. */
  usernameOf: (userId: string) => forgeAccountRepository.usernameOf(userId),

  /** Personne associée à un compte Forgejo, ou null. */
  userIdOf: (username: string) => forgeAccountRepository.userIdOf(username),

  /**
   * Compte Forgejo d'une personne, créé au premier besoin (nom tiré de son e-mail, suffixé en cas de collision ; mot de
   * passe aléatoire jamais communiqué). Un compte Forgejo existant avec la même adresse est adopté.
   */
  ensure(user: Pick<User, 'id' | 'email' | 'name'>): Promise<string> {
    const pending = ensuring.get(user.id);
    if (pending) return pending;
    const task = (async () => {
      const known = await this.usernameOf(user.id);
      if (known) return known;
      const base = forgeUsernameFromEmail(user.email);
      for (let i = 0; i < 20; i++) {
        const username = i === 0 ? base : `${base.slice(0, 36)}-${i + 1}`;
        try {
          await forgejoApi('POST', '/admin/users', {
            username,
            email: user.email,
            full_name: user.name,
            // Mot de passe jamais communiqué : on se connecte à Forgejo par sa session Skipper (authentification par proxy).
            password: `${randomBytes(24).toString('base64url')}Aa1!`,
            must_change_password: false,
            send_notify: false,
            visibility: 'limited',
          });
        } catch (err) {
          if (!(err instanceof ForgejoError && err.status === 422)) throw err;
          // Nom ou adresse déjà pris : on adopte le compte s'il a la même adresse, sinon on essaie le nom suivant.
          const existing = await forgejoApi<{ login: string; email: string }>('GET', `/users/${encodeURIComponent(username)}`).catch(() => null);
          if (!existing || existing.email.toLowerCase() !== user.email.toLowerCase()) {
            if (/e-?mail/i.test(err.message) && !existing) throw new AppError(`Forgejo : l'adresse ${user.email} appartient déjà à un autre compte`);
            continue;
          }
        }
        return forgeAccountRepository.link(user.id, username);
      }
      throw new AppError(`Forgejo : aucun nom de compte libre pour ${user.email}`);
    })().finally(() => ensuring.delete(user.id));
    ensuring.set(user.id, task);
    return task;
  },

  /**
   * Jeton Forgejo que les sessions et terminaux d'une personne utilisent pour fetch et push. Créé par la CLI de Forgejo
   * (l'API refuse cette opération à un administrateur) puis gardé chiffré.
   */
  async agentToken(user: Pick<User, 'id' | 'email' | 'name'>): Promise<string> {
    const username = await this.ensure(user);
    const stored = await forgeAccountRepository.agentToken(user.id);
    if (stored) return decryptSecret(stored);
    const [cmd, ...base] = config.forgejo.cli;
    const name = `skipper-sessions-${Date.now().toString(36)}`;
    const { stdout } = await execFileAsync(cmd, [...base, 'admin', 'user', 'generate-access-token', '--username', username, '--token-name', name, '--scopes', 'write:repository,write:issue,read:user,read:organization', '--raw'], { timeout: 30_000 }).catch((err: Error & { stderr?: string }) => {
      throw new AppError(`Forgejo : le jeton des sessions n'a pas pu être créé (${(err.stderr || err.message).trim().slice(0, 200)})`);
    });
    const token = stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!/^[0-9a-f]{40}$/.test(token)) throw new AppError('Forgejo : réponse inattendue à la création du jeton des sessions');
    await forgeAccountRepository.setAgentToken(user.id, encryptSecret(token));
    return token;
  },
};

// --- Organisation, dépôts, droits ------------------------------------------------

const PERMISSION: Record<ProjectRole, 'read' | 'write' | 'admin'> = { viewer: 'read', member: 'write', admin: 'admin' };

let orgReady: Promise<void> | null = null;

export const forgejoRepos = {
  /** L'organisation de Skipper (privée), créée au premier besoin, avec le webhook vers Skipper. */
  ensureOrg(): Promise<void> {
    if (!orgReady) {
      orgReady = (async () => {
        const org = config.forgejo.org;
        await forgejoApi('GET', `/orgs/${org}`).catch(async (err) => {
          if (!notFound(err)) throw err;
          await forgejoApi('POST', '/orgs', { username: org, full_name: 'Skipper', visibility: 'private', repo_admin_change_team_access: false });
        });
        await this.ensureHook();
      })().catch((err) => {
        orgReady = null;
        throw err;
      });
    }
    return orgReady;
  },

  /** Webhook d'organisation (pushes, pull requests) vers Skipper, signé par le secret partagé. */
  async ensureHook(): Promise<void> {
    if (!config.forgejo.webhookSecret) return;
    const org = config.forgejo.org;
    const hooks = await forgejoApi<Array<{ id: number; config: { url?: string } }>>('GET', `/orgs/${org}/hooks`);
    const body = {
      type: 'forgejo',
      active: true,
      events: ['push', 'pull_request', 'pull_request_sync', 'pull_request_review_approved', 'pull_request_review_rejected', 'pull_request_review_comment'],
      config: { url: config.forgejo.webhookUrl, content_type: 'json', secret: config.forgejo.webhookSecret },
    };
    // Un webhook vers Skipper déjà posé (éventuellement vers une ancienne adresse) est mis à jour plutôt que doublé.
    const existing = hooks.find((h) => h.config?.url === config.forgejo.webhookUrl) ?? hooks.find((h) => h.config?.url?.endsWith('/api/forge/webhook'));
    if (existing) await forgejoApi('PATCH', `/orgs/${org}/hooks/${existing.id}`, body);
    else await forgejoApi('POST', `/orgs/${org}/hooks`, body);
  },

  /**
   * Le dépôt existe-t-il sous ce nom ? Forgejo garde une redirection depuis l'ancien nom d'un dépôt renommé (dépôt d'un
   * projet supprimé, archivé) : seul un dépôt dont le nom est bien celui demandé compte.
   */
  async exists(name: string): Promise<boolean> {
    try {
      const repo = await forgejoApi<{ name: string }>('GET', `/repos/${config.forgejo.org}/${name}`);
      return repo.name.toLowerCase() === name.toLowerCase();
    } catch (err) {
      if (notFound(err)) return false;
      throw err;
    }
  },

  /** Crée le dépôt (privé) ; `autoInit` : avec un premier commit (README) sur la branche principale. */
  async create(name: string, opts: { description?: string | null; defaultBranch: string; autoInit: boolean }): Promise<void> {
    await this.ensureOrg();
    await forgejoApi('POST', `/orgs/${config.forgejo.org}/repos`, {
      name,
      description: opts.description?.slice(0, 2000) ?? '',
      private: true,
      default_branch: opts.defaultBranch,
      auto_init: opts.autoInit,
      readme: opts.autoInit ? 'Default' : undefined,
    });
  },

  /** Branche principale du dépôt dans Forgejo. */
  async setDefaultBranch(name: string, branch: string): Promise<void> {
    await forgejoApi('PATCH', `/repos/${config.forgejo.org}/${name}`, { default_branch: branch });
  },

  /**
   * Collaborateurs du dépôt = membres du projet (lecteur → read, membre → write, administrateur → admin) ; les
   * collaborateurs qui ne sont plus membres sont retirés. Les comptes manquants sont créés.
   */
  async syncCollaborators(name: string, members: Array<{ user: Pick<User, 'id' | 'email' | 'name'>; role: ProjectRole }>): Promise<void> {
    const repo = `/repos/${config.forgejo.org}/${name}`;
    const wanted = new Map<string, 'read' | 'write' | 'admin'>();
    for (const m of members) wanted.set((await forgejoAccounts.ensure(m.user)).toLowerCase(), PERMISSION[m.role]);
    const current = await forgejoApi<Array<{ login: string; permissions?: { admin: boolean; push: boolean } }>>('GET', `${repo}/collaborators`, undefined, { query: { limit: 100 } });
    const currentPerm = new Map(current.map((c) => [c.login.toLowerCase(), c.permissions?.admin ? 'admin' : c.permissions?.push ? 'write' : 'read']));
    for (const [login, permission] of wanted) {
      if (currentPerm.get(login) !== permission) await forgejoApi('PUT', `${repo}/collaborators/${encodeURIComponent(login)}`, { permission });
    }
    for (const login of currentPerm.keys()) {
      if (!wanted.has(login)) await forgejoApi('DELETE', `${repo}/collaborators/${encodeURIComponent(login)}`).catch((err) => log.warn(`[forgejo] ${name} : ${login} non retiré des collaborateurs : ${(err as Error).message}`));
    }
  },
};

// --- Pull requests ----------------------------------------------------------------

interface FjPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged: boolean;
  merged_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  mergeable: boolean;
  merge_commit_sha: string | null;
  user: { login: string; avatar_url: string } | null;
  head: { ref: string; sha: string; repo_id: number };
  base: { ref: string; repo_id: number };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
}

interface FjStatus {
  state: string;
  statuses: Array<{ context: string; status: string; target_url: string | null }> | null;
}

interface FjReview {
  user: { login: string } | null;
  state: string;
  stale?: boolean;
  dismissed?: boolean;
}

const repoPath = (repo: { owner: string; name: string }) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

/** État d'un statut de commit Forgejo, au vocabulaire de Skipper (celui de GitHub). */
function statusState(state: string | null | undefined): string | null {
  switch ((state ?? '').toLowerCase()) {
    case 'success':
      return 'SUCCESS';
    case 'pending':
      return 'PENDING';
    case 'failure':
      return 'FAILURE';
    case 'error':
    case 'warning':
      return 'ERROR';
    default:
      return null;
  }
}

/** Décision de revue : la dernière revue de chaque personne compte ; une demande de changements l'emporte. */
export function reviewDecisionOf(reviews: FjReview[]): string | null {
  const last = new Map<string, string>();
  for (const r of reviews) {
    if (r.dismissed || !r.user || r.state === 'PENDING' || r.state === 'COMMENT') continue;
    last.set(r.user.login, r.state);
  }
  const states = [...last.values()];
  if (states.includes('REQUEST_CHANGES')) return 'CHANGES_REQUESTED';
  if (states.includes('APPROVED')) return 'APPROVED';
  return null;
}

const reviewState = (s: string) => (s === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : s === 'COMMENT' ? 'COMMENTED' : s === 'REQUEST_REVIEW' ? 'PENDING' : s);

/** PR Forgejo au format de Skipper ; `details` : statuts du dernier commit et revues (lus pour les PR ouvertes). */
export function toPullRequest(projectId: string, repo: { owner: string; name: string }, p: FjPull, details: { status?: FjStatus | null; reviews?: FjReview[] } = {}): PullRequest {
  const state = p.merged ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : 'OPEN';
  const checksState = statusState(details.status?.state);
  const reviewDecision = reviewDecisionOf(details.reviews ?? []);
  const isDraft = Boolean(p.draft) || /^(wip:|\[wip\])/i.test(p.title.trim());
  const mergeable = state !== 'OPEN' ? 'UNKNOWN' : p.mergeable ? 'MERGEABLE' : 'CONFLICTING';
  const mergeStateStatus = state !== 'OPEN' ? 'UNKNOWN' : isDraft ? 'DRAFT' : !p.mergeable ? 'DIRTY' : checksState === 'FAILURE' || checksState === 'ERROR' ? 'UNSTABLE' : reviewDecision === 'CHANGES_REQUESTED' ? 'BLOCKED' : 'CLEAN';
  return {
    projectId,
    repo: `${repo.owner}/${repo.name}`,
    number: p.number,
    title: p.title,
    body: p.body ?? '',
    url: p.html_url,
    state,
    isDraft,
    author: p.user?.login ?? null,
    authorAvatarUrl: p.user?.avatar_url ?? null,
    headRefName: p.head.ref,
    baseRefName: p.base.ref,
    isCrossRepository: p.head.repo_id !== p.base.repo_id,
    mergeable,
    mergeStateStatus,
    reviewDecision,
    checksState,
    checks: (details.status?.statuses ?? []).map((s) => ({ name: s.context, state: statusState(s.status) ?? 'PENDING', url: s.target_url || null })),
    reviews: (details.reviews ?? []).filter((r) => r.user && !r.dismissed).map((r) => ({ author: r.user!.login, state: reviewState(r.state) })),
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changed_files ?? 0,
    commitCount: p.commits ?? 0,
    createdAt: new Date(p.created_at),
    updatedAt: new Date(p.updated_at),
    mergedAt: p.merged_at ? new Date(p.merged_at) : null,
    closedAt: p.closed_at ? new Date(p.closed_at) : null,
  };
}

async function withDetails(projectId: string, repo: { owner: string; name: string }, p: FjPull): Promise<PullRequest> {
  if (p.state !== 'open') return toPullRequest(projectId, repo, p);
  const [status, reviews] = await Promise.all([
    forgejoApi<FjStatus>('GET', `${repoPath(repo)}/commits/${p.head.sha}/status`).catch(() => null),
    forgejoApi<FjReview[]>('GET', `${repoPath(repo)}/pulls/${p.number}/reviews`).catch(() => []),
  ]);
  return toPullRequest(projectId, repo, p, { status, reviews });
}

export const forgejoPulls = {
  async defaultBranch(repo: { owner: string; name: string }): Promise<string> {
    return (await forgejoApi<{ default_branch: string }>('GET', repoPath(repo))).default_branch;
  },

  /** PR du dépôt, les plus récemment mises à jour d'abord (statuts et revues lus pour les PR ouvertes). */
  async list(projectId: string, repo: { owner: string; name: string }, filter: PullRequestFilter, limit: number): Promise<PullRequest[]> {
    const state = filter === 'OPEN' ? 'open' : filter === 'ALL' ? 'all' : 'closed';
    const pulls: FjPull[] = [];
    for (let page = 1; pulls.length < limit && page <= 5; page++) {
      const batch = await forgejoApi<FjPull[]>('GET', `${repoPath(repo)}/pulls`, undefined, { query: { state, sort: 'recentupdate', limit: 50, page } });
      pulls.push(...batch);
      if (batch.length < 50) break;
    }
    const kept = pulls.filter((p) => (filter === 'MERGED' ? p.merged : filter === 'CLOSED' ? !p.merged : true)).slice(0, limit);
    return Promise.all(kept.map((p) => withDetails(projectId, repo, p)));
  },

  async get(projectId: string, repo: { owner: string; name: string }, number: number): Promise<PullRequest> {
    const p = await forgejoApi<FjPull>('GET', `${repoPath(repo)}/pulls/${number}`).catch((err) => {
      if (notFound(err)) throw new AppError(`Pull request #${number} introuvable dans ${repo.owner}/${repo.name}`);
      throw err;
    });
    return withDetails(projectId, repo, p);
  },

  /** Ouvre la PR au nom de `sudo` ; un brouillon est marqué par le préfixe « WIP: » (convention de Forgejo). */
  async create(repo: { owner: string; name: string }, input: { title: string; head: string; base: string; body: string; draft: boolean }, sudo: string | null): Promise<number> {
    const title = input.draft && !/^wip:/i.test(input.title) ? `WIP: ${input.title}` : input.title;
    try {
      const created = await forgejoApi<FjPull>('POST', `${repoPath(repo)}/pulls`, { title, head: input.head, base: input.base, body: input.body }, { sudo });
      return created.number;
    } catch (err) {
      if (err instanceof ForgejoError && err.status === 409) throw new AppError(`Une pull request est déjà ouverte pour la branche ${input.head}`);
      if (err instanceof ForgejoError && err.status === 422 && /no commits|nothing to compare|same/i.test(err.message)) throw new AppError(`Aucun commit entre ${input.base} et ${input.head} : rien à proposer`);
      throw err;
    }
  },

  /** Fusionne au nom de `sudo` ; renvoie le commit de fusion. */
  async merge(repo: { owner: string; name: string }, number: number, method: 'MERGE' | 'SQUASH' | 'REBASE', sudo: string | null): Promise<string | null> {
    try {
      await forgejoApi('POST', `${repoPath(repo)}/pulls/${number}/merge`, { Do: method === 'MERGE' ? 'merge' : method === 'SQUASH' ? 'squash' : 'rebase' }, { sudo });
    } catch (err) {
      if (err instanceof ForgejoError && (err.status === 405 || err.status === 409)) throw new AppError(`Fusion refusée par Forgejo : ${err.message.replace(/^Forgejo \(\d+\) : /, '')}`);
      throw err;
    }
    return (await forgejoApi<FjPull>('GET', `${repoPath(repo)}/pulls/${number}`)).merge_commit_sha ?? null;
  },

  async deleteBranch(repo: { owner: string; name: string }, branch: string): Promise<void> {
    await forgejoApi('DELETE', `${repoPath(repo)}/branches/${branch.split('/').map(encodeURIComponent).join('/')}`).catch((err) => {
      // Branche déjà supprimée : 404, ou 500 « object does not exist » selon les versions de Forgejo.
      if (!notFound(err) && !(err instanceof ForgejoError && /does not exist/i.test(err.message))) throw err;
    });
  },
};
