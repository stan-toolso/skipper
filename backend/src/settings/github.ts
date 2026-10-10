import { AppError, NotFoundError } from '../errors.js';
import { vaultService } from '../vault/service.js';
import type { VaultActor } from '../vault/types.js';
import { githubAccountRepository, type GithubAccountRecord } from './githubRepository.js';

/**
 * Comptes GitHub d'UNE personne (plusieurs possibles), connectés avec un code (device flow, comme
 * `gh auth login`) ou avec un jeton d'accès personnel gardé dans son coffre. Tout jeton vit dans le
 * COFFRE (jeton applicatif 'github') : une connexion par code le range dans le coffre personnel de la
 * personne (jamais révélable, renouvelé par Skipper), un jeton personnel est un élément qu'elle a créé et
 * choisi. Les jetons servent aux commandes git de la personne (clone, fetch, push), à ses appels à l'API
 * GitHub (dépôts, pull requests) et aux agents des sessions qu'elle possède ; chaque usage vérifie qu'elle
 * peut toujours utiliser l'élément. Pour un dépôt, le compte employé est celui dont l'identifiant ou les
 * organisations possèdent le dépôt, sinon le compte par défaut.
 */

const USER_AGENT = 'skipper';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
/** Portées demandées par le device flow : dépôts (lecture/écriture), organisations (choix du compte d'après le propriétaire), workflows. */
export const OAUTH_SCOPES = ['repo', 'read:org', 'workflow'];
/** Un jeton qui expire est renouvelé quand il lui reste moins que ceci. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface GithubAccount {
  id: string;
  login: string;
  avatarUrl: string | null;
  method: 'oauth' | 'pat';
  scopes: string[];
  organizations: string[];
  isDefault: boolean;
  /** Élément du coffre qui détient le jeton. */
  vaultItemId: string;
  connectedAt: Date;
  tokenExpiresAt: Date | null;
}

export interface GithubAuthStatus {
  connected: boolean;
  /** Compte par défaut. */
  login: string | null;
  avatarUrl: string | null;
  scopes: string[];
  tokenSetAt: Date | null;
  accounts: GithubAccount[];
  /** La connexion par code (device flow) est possible sur ce serveur. */
  deviceAvailable: boolean;
}

export interface GithubRepository {
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  pushedAt: Date | null;
  /** Identifiant du compte connecté avec lequel le dépôt a été listé. */
  account: string;
}

/** Jeton en clair d'un compte, et les propriétaires qu'il sert (son identifiant et ses organisations, en minuscules). */
export interface GithubCredential {
  login: string;
  token: string;
  owners: string[];
  isDefault: boolean;
}

export interface TokenResponse {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function githubFetch(url: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT, ...((init.headers as Record<string, string>) ?? {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  return fetch(url, { ...init, headers });
}

/** Propriétaire (personne ou organisation) d'une URL de dépôt GitHub (https, ssh, alias `github-xxx`), en minuscules. */
export function githubOwnerOf(url: string | null | undefined): string | null {
  const u = (url ?? '').trim();
  const m = u.match(/^https?:\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/([^/]+)\//i) ?? u.match(/^(?:ssh:\/\/)?git@github[\w.-]*(?::|\/)([^/]+)\//i);
  return m ? m[1].toLowerCase() : null;
}

/** Identifiant à employer pour un propriétaire de dépôt : le compte qui le possède, sinon le compte par défaut, sinon le premier. */
export function pickCredential<T extends { owners: string[]; isDefault: boolean }>(creds: T[], owner: string | null | undefined): T | null {
  const o = owner?.toLowerCase();
  return (o ? creds.find((c) => c.owners.includes(o)) : undefined) ?? creds.find((c) => c.isDefault) ?? creds[0] ?? null;
}

const toPublic = (a: GithubAccountRecord): GithubAccount => ({
  id: a.id,
  login: a.login,
  avatarUrl: a.avatarUrl,
  method: a.method,
  scopes: a.scopes,
  organizations: a.organizations,
  isDefault: a.isDefault,
  vaultItemId: a.vaultItemId,
  connectedAt: a.updatedAt,
  tokenExpiresAt: a.tokenExpiresAt,
});

const inSeconds = (s: number | undefined) => (s ? new Date(Date.now() + s * 1000) : null);

/** Profil et organisations du compte d'un jeton. Les organisations demandent `read:org` (OAuth) ou sont celles visibles d'un jeton personnel. */
export async function readAccount(token: string): Promise<{ login: string; avatarUrl: string | null; scopes: string[]; organizations: string[] }> {
  const res = await githubFetch('https://api.github.com/user', { token });
  if (res.status === 401) throw new AppError('GitHub refuse ce jeton (invalide, expiré ou révoqué)');
  if (!res.ok) throw new AppError(`GitHub : vérification impossible (${res.status})`);
  const user = (await res.json()) as { login: string; avatar_url?: string };
  // Les jetons classiques et OAuth annoncent leurs portées ; les jetons à granularité fine n'en ont pas.
  const scopes = (res.headers.get('x-oauth-scopes') ?? '').split(/[ ,]+/).filter(Boolean);
  let organizations: string[] = [];
  try {
    const orgs = await githubFetch('https://api.github.com/user/orgs?per_page=100', { token });
    if (orgs.ok) organizations = ((await orgs.json()) as Array<{ login: string }>).map((o) => o.login);
  } catch (err) {
    console.warn(`[github] organisations illisibles pour ${user.login} : ${(err as Error).message}`);
  }
  return { login: user.login, avatarUrl: user.avatar_url ?? null, scopes, organizations };
}

/** Renouvellement d'un jeton qui expire (device flow avec jetons expirants). */
async function refreshRequest(clientId: string, refreshToken: string): Promise<TokenResponse> {
  const res = await githubFetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }) });
  if (!res.ok) throw new AppError(`GitHub : renouvellement impossible (${res.status})`);
  const data = (await res.json()) as TokenResponse;
  if (data.error || !data.access_token) throw new AppError(`GitHub : ${data.error_description ?? data.error ?? 'aucun jeton reçu'}`);
  return data;
}

/**
 * Jeton en clair d'un compte, lu dans son élément du coffre (la personne doit encore pouvoir l'utiliser),
 * renouvelé d'abord s'il expire bientôt. Null s'il est inutilisable ou plus renouvelable.
 */
async function freshToken(a: GithubAccountRecord, actor: Omit<VaultActor, 'userId'> = {}): Promise<string | null> {
  let used: Awaited<ReturnType<typeof vaultService.useToken>>;
  try {
    used = await vaultService.useToken(a.userId, a.vaultItemId, ['github'], { ...actor, userId: a.userId, purpose: `Compte GitHub ${a.login}` });
  } catch (err) {
    console.warn(`[github] jeton inutilisable pour ${a.login} : ${(err as Error).message}`);
    return null;
  }
  const { item, secrets } = used;
  const token = secrets.token;
  if (!a.tokenExpiresAt || a.tokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return token;
  const clientId = secrets.clientId;
  if (!secrets.refreshToken || !clientId || (a.refreshTokenExpiresAt && a.refreshTokenExpiresAt.getTime() < Date.now())) {
    console.warn(`[github] jeton expiré et non renouvelable pour ${a.login} : reconnexion nécessaire`);
    return a.tokenExpiresAt.getTime() > Date.now() ? token : null;
  }
  try {
    const t = await refreshRequest(clientId, secrets.refreshToken);
    const expiry = { tokenExpiresAt: inSeconds(t.expires_in), refreshTokenExpiresAt: t.refresh_token ? inSeconds(t.refresh_token_expires_in) : a.refreshTokenExpiresAt };
    await vaultService.refreshToken(item, { token: t.access_token!, refreshToken: t.refresh_token ?? secrets.refreshToken, clientId }, { tokenExpiresAt: expiry.tokenExpiresAt, refreshExpiresAt: expiry.refreshTokenExpiresAt });
    await githubAccountRepository.updateExpiry(a.id, expiry);
    return t.access_token!;
  } catch (err) {
    console.warn(`[github] renouvellement du jeton de ${a.login} impossible : ${(err as Error).message}`);
    return a.tokenExpiresAt.getTime() > Date.now() ? token : null;
  }
}

/** Compte d'un jeton obtenu par le device flow : le jeton va dans le coffre personnel de la personne. */
export async function storeOAuthAccount(userId: string, t: TokenResponse, clientId: string): Promise<GithubAccount> {
  const info = await readAccount(t.access_token!);
  const previous = (await githubAccountRepository.listByUser(userId)).find((a) => a.login.toLowerCase() === info.login.toLowerCase());
  const tokenExpiresAt = inSeconds(t.expires_in);
  const refreshTokenExpiresAt = inSeconds(t.refresh_token_expires_in);
  const item = await vaultService.storeOauthToken(userId, {
    service: 'github',
    name: `github-${info.login.toLowerCase()}`,
    account: info.login,
    secrets: { token: t.access_token!, ...(t.refresh_token ? { refreshToken: t.refresh_token, clientId } : {}) },
    tokenExpiresAt,
    refreshExpiresAt: refreshTokenExpiresAt,
    existingId: previous?.method === 'oauth' ? previous.vaultItemId : null,
  });
  const account = await githubAccountRepository.upsert(userId, {
    ...info,
    scopes: t.scope ? t.scope.split(/[ ,]+/).filter(Boolean) : info.scopes,
    method: 'oauth',
    vaultItemId: item.id,
    tokenExpiresAt,
    refreshTokenExpiresAt,
  });
  console.log(`[github] compte ${account.login} connecté (code) pour ${userId}`);
  return toPublic(account);
}

/** Identifiants git transmis aux commandes et aux agents. */
export interface GitAuth {
  token: string;
  name: string;
  email: string;
  accounts: GithubCredential[];
}

export const githubService = {
  /** Jeton d'accès personnel gardé dans un élément du coffre que la personne peut utiliser : vérifié auprès de GitHub, puis son compte connecté. */
  async connectFromVault(userId: string, itemId: string): Promise<GithubAccount> {
    const { item, secrets } = await vaultService.useToken(userId, itemId, ['github'], { userId, purpose: 'Connexion du compte GitHub' });
    const info = await readAccount(secrets.token);
    const account = await githubAccountRepository.upsert(userId, {
      ...info,
      scopes: info.scopes.length ? info.scopes : ['(jeton à granularité fine)'],
      method: 'pat',
      vaultItemId: item.id,
      tokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
    console.log(`[github] compte ${account.login} connecté (jeton du coffre) pour ${userId}`);
    return toPublic(account);
  },

  /** Compte connu par son identifiant (migration) : le jeton est déjà dans le coffre, GitHub n'est pas interrogé. */
  async connectKnown(userId: string, itemId: string, info: { login: string; avatarUrl: string | null; scopes: string[]; method: 'oauth' | 'pat' }): Promise<GithubAccount> {
    const account = await githubAccountRepository.upsert(userId, { ...info, organizations: [], vaultItemId: itemId, tokenExpiresAt: null, refreshTokenExpiresAt: null });
    return toPublic(account);
  },

  async accounts(userId: string): Promise<GithubAccount[]> {
    return (await githubAccountRepository.listByUser(userId)).map(toPublic);
  },

  async status(userId: string, deviceAvailable: boolean): Promise<GithubAuthStatus> {
    const accounts = await this.accounts(userId);
    const main = accounts.find((a) => a.isDefault) ?? accounts[0] ?? null;
    return {
      connected: accounts.length > 0,
      login: main?.login ?? null,
      avatarUrl: main?.avatarUrl ?? null,
      scopes: main?.scopes ?? [],
      tokenSetAt: main?.connectedAt ?? null,
      accounts,
      deviceAvailable,
    };
  },

  async setDefault(userId: string, accountId: string): Promise<void> {
    if (!(await githubAccountRepository.findById(userId, accountId))) throw new NotFoundError('Compte GitHub introuvable');
    await githubAccountRepository.setDefault(userId, accountId);
  },

  /**
   * Oublie un compte (tous sans `accountId`). Le jeton obtenu par une connexion est retiré du coffre avec
   * lui ; un jeton personnel reste dans le coffre (élément de la personne). L'autorisation reste valable
   * côté GitHub tant qu'elle n'y est pas révoquée.
   */
  async disconnect(userId: string, accountId?: string | null): Promise<void> {
    const accounts = (await githubAccountRepository.listByUser(userId)).filter((a) => !accountId || a.id === accountId);
    if (accountId && !accounts.length) throw new NotFoundError('Compte GitHub introuvable');
    for (const a of accounts) {
      await githubAccountRepository.delete(userId, a.id);
      if (a.method === 'oauth') await vaultService.deleteOauthToken(userId, a.vaultItemId);
    }
  },

  /** Jetons en clair de chaque compte de la personne (renouvelés si besoin), les inutilisables écartés. Un usage par une session est journalisé (`actor`). */
  async credentials(userId: string | null | undefined, actor: Omit<VaultActor, 'userId'> = {}): Promise<GithubCredential[]> {
    if (!userId) return [];
    const out: GithubCredential[] = [];
    for (const a of await githubAccountRepository.listByUser(userId)) {
      const token = await freshToken(a, actor);
      if (token) out.push({ login: a.login, token, owners: [a.login, ...a.organizations].map((o) => o.toLowerCase()), isDefault: a.isDefault });
    }
    return out;
  },

  /** Jeton en clair pour un propriétaire de dépôt (voir `pickCredential`), ou null sans compte utilisable. */
  async token(userId: string | null | undefined, owner?: string | null): Promise<string | null> {
    return pickCredential(await this.credentials(userId), owner)?.token ?? null;
  },

  /** Identifiants git d'une personne pour un dépôt : jeton du compte qui sert le dépôt et identité dérivée de son identifiant ; null sans compte. */
  async gitAuth(userId: string | null | undefined, repoUrl?: string | null, actor: Omit<VaultActor, 'userId'> = {}): Promise<GitAuth | null> {
    const accounts = await this.credentials(userId, actor);
    const main = pickCredential(accounts, githubOwnerOf(repoUrl));
    if (!main) return null;
    return { token: main.token, name: main.login, email: `${main.login}@users.noreply.github.com`, accounts };
  },

  /** Arguments `-c` à ajouter aux commandes git pour authentifier les URL https de github.com avec le compte de la personne qui sert le dépôt. */
  async gitConfigArgs(userId: string | null | undefined, repoUrl?: string | null): Promise<string[]> {
    const token = await this.token(userId, githubOwnerOf(repoUrl));
    if (!token) return [];
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
  },

  /** Dépôts accessibles avec les comptes de la personne, les plus récemment poussés d'abord ; `query` filtre sur le nom complet. */
  async listRepositories(userId: string, query?: string | null): Promise<GithubRepository[]> {
    const creds = await this.credentials(userId);
    if (!creds.length) throw new AppError('GitHub non connecté : connectez un compte dans Paramètres → GitHub', 'GITHUB_NOT_CONNECTED');
    const byName = new Map<string, GithubRepository>();
    // Compte par défaut d'abord : un dépôt accessible par plusieurs comptes est listé avec lui.
    for (const cred of [...creds].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))) {
      for (let page = 1; page <= 3; page++) {
        const res = await githubFetch(`https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`, { token: cred.token });
        if (!res.ok) {
          console.warn(`[github] dépôts indisponibles pour ${cred.login} (${res.status})`);
          break;
        }
        const list = (await res.json()) as Array<{ full_name: string; name: string; owner: { login: string }; description: string | null; private: boolean; default_branch: string; clone_url: string; html_url: string; pushed_at: string | null }>;
        for (const r of list) {
          if (byName.has(r.full_name.toLowerCase())) continue;
          byName.set(r.full_name.toLowerCase(), {
            fullName: r.full_name,
            name: r.name,
            owner: r.owner.login,
            description: r.description,
            private: r.private,
            defaultBranch: r.default_branch,
            cloneUrl: r.clone_url,
            htmlUrl: r.html_url,
            pushedAt: r.pushed_at ? new Date(r.pushed_at) : null,
            account: cred.login,
          });
        }
        if (list.length < 100) break;
      }
    }
    const repos = [...byName.values()].sort((a, b) => (b.pushedAt?.getTime() ?? 0) - (a.pushedAt?.getTime() ?? 0));
    const q = query?.trim().toLowerCase();
    return q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos;
  },
};
