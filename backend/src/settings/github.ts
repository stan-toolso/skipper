import { AppError } from '../errors.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { settingsRepository } from './repository.js';

/**
 * Connexion GitHub par OAuth « device flow » : l'utilisateur saisit un code sur github.com,
 * le backend récupère un jeton utilisateur qu'il stocke chiffré. Le jeton sert aux commandes git
 * (clone, fetch) sur les dépôts privés et à l'API GitHub (liste des dépôts).
 * Il faut une OAuth App GitHub avec le device flow activé ; seul son client id (public) est requis.
 */

const SCOPES = 'repo read:org';
const SETTINGS_KEY = 'github';
const SECRETS_KEY = 'github.secrets';

interface GithubSettings {
  clientId: string | null;
}
interface GithubSecrets {
  token: string; // chiffré
  tokenSetAt: string;
  login: string;
  scopes: string[];
  avatarUrl?: string | null;
  /** 'pat' (jeton personnel collé) ou 'oauth' (device flow). */
  method?: 'pat' | 'oauth';
}

export interface GithubLogin {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
  /** pending, done, failed, expired, cancelled */
  status: string;
  error: string | null;
  createdAt: string;
}

export interface GithubAuthStatus {
  clientId: string | null;
  /** 'env' (GITHUB_CLIENT_ID), 'settings' (saisi dans l'interface) ou null. */
  clientIdSource: 'env' | 'settings' | null;
  connected: boolean;
  method: 'pat' | 'oauth' | null;
  login: string | null;
  avatarUrl: string | null;
  scopes: string[];
  tokenSetAt: string | null;
  currentLogin: GithubLogin | null;
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
  pushedAt: string | null;
}

interface DeviceState extends GithubLogin {
  deviceCode: string;
  timer: NodeJS.Timeout | null;
}

let current: DeviceState | null = null;

async function githubFetch(url: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'skipper', ...(init.headers as Record<string, string>) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(url, { ...init, headers });
  return res;
}

const publicLogin = (s: DeviceState): GithubLogin => ({
  id: s.id,
  userCode: s.userCode,
  verificationUri: s.verificationUri,
  expiresAt: s.expiresAt,
  intervalSeconds: s.intervalSeconds,
  status: s.status,
  error: s.error,
  createdAt: s.createdAt,
});

export const githubService = {
  async clientId(): Promise<{ clientId: string | null; source: 'env' | 'settings' | null }> {
    if (process.env.GITHUB_CLIENT_ID) return { clientId: process.env.GITHUB_CLIENT_ID, source: 'env' };
    const s = await settingsRepository.get<GithubSettings>(SETTINGS_KEY);
    return s?.clientId ? { clientId: s.clientId, source: 'settings' } : { clientId: null, source: null };
  },

  async setClientId(clientId: string | null): Promise<void> {
    const value = clientId?.trim() || null;
    if (value && !/^[A-Za-z0-9._-]{8,80}$/.test(value)) throw new AppError("Identifiant d'application GitHub invalide");
    await settingsRepository.set<GithubSettings>(SETTINGS_KEY, { clientId: value });
  },

  async secrets(): Promise<GithubSecrets | null> {
    return settingsRepository.get<GithubSecrets>(SECRETS_KEY);
  },

  /** Jeton en clair, ou null si non connecté. */
  async token(): Promise<string | null> {
    const s = await this.secrets();
    if (!s) return null;
    try {
      return decryptSecret(s.token);
    } catch (err) {
      console.error('[github] jeton illisible', err);
      return null;
    }
  },

  async status(): Promise<GithubAuthStatus> {
    const [{ clientId, source }, secrets] = await Promise.all([this.clientId(), this.secrets()]);
    return {
      clientId,
      clientIdSource: source,
      connected: Boolean(secrets),
      method: secrets?.method ?? (secrets ? 'oauth' : null),
      login: secrets?.login ?? null,
      avatarUrl: secrets?.avatarUrl ?? null,
      scopes: secrets?.scopes ?? [],
      tokenSetAt: secrets?.tokenSetAt ?? null,
      currentLogin: current ? publicLogin(current) : null,
    };
  },

  /** Démarre le device flow et lance l'attente de validation en tâche de fond. */
  async startLogin(): Promise<GithubLogin> {
    const { clientId } = await this.clientId();
    if (!clientId) throw new AppError("Renseignez d'abord l'identifiant de l'application GitHub (client id)");
    if (current?.timer) clearInterval(current.timer);

    const res = await githubFetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, scope: SCOPES }),
    });
    const body = (await res.json()) as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string; error_description?: string };
    if (!res.ok || !body.device_code) {
      throw new AppError(`GitHub a refusé la demande : ${body.error_description ?? body.error ?? res.status}. Vérifiez que le device flow est activé sur l'OAuth App.`);
    }

    const state: DeviceState = {
      id: `gh-${Date.now()}`,
      deviceCode: body.device_code,
      userCode: body.user_code!,
      verificationUri: body.verification_uri ?? 'https://github.com/login/device',
      expiresAt: new Date(Date.now() + (body.expires_in ?? 900) * 1000).toISOString(),
      intervalSeconds: Math.max(5, body.interval ?? 5),
      status: 'pending',
      error: null,
      createdAt: new Date().toISOString(),
      timer: null,
    };
    current = state;

    const poll = async () => {
      if (current !== state || state.status !== 'pending') return;
      if (Date.now() > new Date(state.expiresAt).getTime()) {
        state.status = 'expired';
        state.error = 'Le code a expiré, relancez la connexion.';
        if (state.timer) clearInterval(state.timer);
        return;
      }
      try {
        const r = await githubFetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, device_code: state.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
        });
        const data = (await r.json()) as { access_token?: string; scope?: string; error?: string; error_description?: string; interval?: number };
        if (data.access_token) {
          if (state.timer) clearInterval(state.timer);
          const user = await this.fetchUser(data.access_token);
          await settingsRepository.set<GithubSecrets>(SECRETS_KEY, {
            token: encryptSecret(data.access_token),
            tokenSetAt: new Date().toISOString(),
            login: user.login,
            avatarUrl: user.avatarUrl,
            scopes: (data.scope ?? '').split(/[ ,]+/).filter(Boolean),
            method: 'oauth',
          });
          state.status = 'done';
          return;
        }
        switch (data.error) {
          case 'authorization_pending':
            return;
          case 'slow_down':
            if (state.timer) clearInterval(state.timer);
            state.intervalSeconds = (data.interval ?? state.intervalSeconds) + 5;
            state.timer = setInterval(() => void poll(), state.intervalSeconds * 1000);
            return;
          case 'expired_token':
            state.status = 'expired';
            state.error = 'Le code a expiré, relancez la connexion.';
            break;
          case 'access_denied':
            state.status = 'failed';
            state.error = 'Autorisation refusée sur GitHub.';
            break;
          default:
            state.status = 'failed';
            state.error = data.error_description ?? data.error ?? 'Réponse inattendue de GitHub';
        }
      } catch (err) {
        state.status = 'failed';
        state.error = (err as Error).message;
      }
      if (state.timer) clearInterval(state.timer);
    };
    state.timer = setInterval(() => void poll(), state.intervalSeconds * 1000);
    return publicLogin(state);
  },

  /** Jeton d'accès personnel (classique ou à granularité fine) collé par l'utilisateur : vérifié puis stocké chiffré. */
  async setPersonalToken(rawToken: string): Promise<void> {
    const token = rawToken.trim();
    if (!/^(ghp_|github_pat_|gho_|ghu_)[A-Za-z0-9_]{20,}$/.test(token)) {
      throw new AppError("Ce n'est pas un jeton GitHub (attendu : ghp_… ou github_pat_…)");
    }
    const res = await githubFetch('https://api.github.com/user', { token });
    if (res.status === 401) throw new AppError('GitHub refuse ce jeton (invalide, expiré ou révoqué)');
    if (!res.ok) throw new AppError(`GitHub : vérification impossible (${res.status})`);
    const u = (await res.json()) as { login: string; avatar_url?: string };
    // Les jetons classiques annoncent leurs portées ; les jetons à granularité fine n'en ont pas.
    const scopes = (res.headers.get('x-oauth-scopes') ?? '').split(/[ ,]+/).filter(Boolean);
    this.cancelLogin();
    await settingsRepository.set<GithubSecrets>(SECRETS_KEY, {
      token: encryptSecret(token),
      tokenSetAt: new Date().toISOString(),
      login: u.login,
      avatarUrl: u.avatar_url ?? null,
      scopes: scopes.length ? scopes : ['(jeton à granularité fine)'],
      method: 'pat',
    });
  },

  cancelLogin(): void {
    if (current?.timer) clearInterval(current.timer);
    if (current) current.status = 'cancelled';
    current = null;
  },

  async disconnect(): Promise<void> {
    this.cancelLogin();
    await settingsRepository.delete(SECRETS_KEY);
  },

  async fetchUser(token: string): Promise<{ login: string; avatarUrl: string | null }> {
    const res = await githubFetch('https://api.github.com/user', { token });
    if (!res.ok) throw new AppError(`GitHub : impossible de lire le profil (${res.status})`);
    const u = (await res.json()) as { login: string; avatar_url?: string };
    return { login: u.login, avatarUrl: u.avatar_url ?? null };
  },

  /** Dépôts accessibles à l'utilisateur connecté, les plus récents d'abord ; `query` filtre sur le nom. */
  async listRepositories(query?: string | null): Promise<GithubRepository[]> {
    const token = await this.token();
    if (!token) throw new AppError('GitHub non connecté');
    const repos: GithubRepository[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await githubFetch(`https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`, { token });
      if (!res.ok) throw new AppError(`GitHub : liste des dépôts indisponible (${res.status})`);
      const list = (await res.json()) as Array<{ full_name: string; name: string; owner: { login: string }; description: string | null; private: boolean; default_branch: string; clone_url: string; html_url: string; pushed_at: string | null }>;
      for (const r of list) {
        repos.push({ fullName: r.full_name, name: r.name, owner: r.owner.login, description: r.description, private: r.private, defaultBranch: r.default_branch, cloneUrl: r.clone_url, htmlUrl: r.html_url, pushedAt: r.pushed_at });
      }
      if (list.length < 100) break;
    }
    const q = query?.trim().toLowerCase();
    return q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos;
  },

  /** Arguments `-c` à ajouter aux commandes git pour authentifier les URL https de github.com. */
  async gitConfigArgs(): Promise<string[]> {
    const token = await this.token();
    if (!token) return [];
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
  },
};
