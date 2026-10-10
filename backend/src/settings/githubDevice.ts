import { AppError } from '../errors.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { githubFetch, OAUTH_SCOPES, storeOAuthAccount, type GithubAccount, type TokenResponse } from './github.js';

/**
 * Connexion d'un compte GitHub avec un code (OAuth device flow, comme `gh auth login`) : Skipper demande
 * un code à GitHub, la personne le saisit sur github.com/login/device et autorise, la page interroge
 * jusqu'à ce que GitHub remette le jeton, rangé dans le coffre personnel. Sans secret client ni rappel :
 * le client public du CLI GitHub convient tant qu'aucune OAuth App propre à Skipper n'est configurée
 * (`GITHUB_CLIENT_ID`, device flow activé ; `GITHUB_CLIENT_ID=none` désactive la connexion par code).
 *
 * Sans état : l'identifiant remis à la page est le code d'appareil et son propriétaire, chiffrés avec la
 * clé du serveur, donc nul autre ne peut l'interroger.
 */

/** Identifiant public du client de GitHub CLI (github.com/cli/cli, internal/authflow). */
export const GH_CLI_CLIENT_ID = '178c6fc778ccc68e1d6a';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface GithubDeviceLogin {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: Date;
  /** Secondes à attendre entre deux interrogations. */
  interval: number;
}

export type GithubDevicePollStatus = 'pending' | 'connected' | 'expired' | 'denied';

export interface GithubDevicePoll {
  status: GithubDevicePollStatus;
  /** Secondes à attendre avant la prochaine interrogation (allongées par GitHub quand on va trop vite). */
  interval: number;
  account: GithubAccount | null;
}

interface DeviceState {
  /** Code d'appareil. */
  d: string;
  /** Propriétaire (identifiant de la personne). */
  u: string;
  /** Expiration (ms epoch). */
  e: number;
}

export function clientId(): string | null {
  const id = process.env.GITHUB_CLIENT_ID?.trim() || GH_CLI_CLIENT_ID;
  return id.toLowerCase() === 'none' ? null : id;
}

export const githubDeviceAvailable = () => clientId() !== null;

function requireClientId(): string {
  const id = clientId();
  if (!id) throw new AppError('La connexion GitHub par code est désactivée sur ce serveur (GITHUB_CLIENT_ID=none)');
  return id;
}

async function postForm<T>(url: string, params: Record<string, string>): Promise<T> {
  const res = await githubFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  if (!res.ok) throw new AppError(`GitHub : impossible de démarrer la connexion par code (${res.status})`);
  return (await res.json()) as T;
}

function readState(id: string, userId: string): DeviceState {
  let state: DeviceState;
  try {
    state = JSON.parse(decryptSecret(id)) as DeviceState;
  } catch {
    throw new AppError('Connexion GitHub introuvable : recommencez');
  }
  if (state.u !== userId) throw new AppError('Connexion GitHub introuvable : recommencez');
  return state;
}

export const githubDeviceService = {
  /** Demande à GitHub un code que la personne saisit sur `verificationUri`. */
  async start(userId: string): Promise<GithubDeviceLogin> {
    const data = await postForm<{ device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string; error_description?: string }>(DEVICE_CODE_URL, {
      client_id: requireClientId(),
      scope: OAUTH_SCOPES.join(' '),
    });
    if (data.error || !data.device_code || !data.user_code) throw new AppError(`GitHub : ${data.error_description ?? data.error ?? 'aucun code reçu'}. Vérifiez que le device flow est activé sur l'OAuth App.`);
    const expiresAt = new Date(Date.now() + (data.expires_in ?? 900) * 1000);
    return {
      id: encryptSecret(JSON.stringify({ d: data.device_code, u: userId, e: expiresAt.getTime() } satisfies DeviceState)),
      userCode: data.user_code,
      verificationUri: data.verification_uri ?? 'https://github.com/login/device',
      expiresAt,
      interval: data.interval ?? 5,
    };
  },

  /** Une interrogation d'une connexion lancée par la personne : enregistre le compte une fois l'autorisation donnée. */
  async poll(userId: string, id: string): Promise<GithubDevicePoll> {
    const state = readState(id, userId);
    if (state.e < Date.now()) return { status: 'expired', interval: 0, account: null };
    const client = requireClientId();
    const t = await postForm<TokenResponse & { interval?: number }>(TOKEN_URL, { client_id: client, device_code: state.d, grant_type: DEVICE_GRANT });
    switch (t.error) {
      case undefined:
        if (!t.access_token) throw new AppError('GitHub : aucun jeton reçu');
        return { status: 'connected', interval: 0, account: await storeOAuthAccount(userId, t, client) };
      case 'authorization_pending':
        return { status: 'pending', interval: t.interval ?? 5, account: null };
      case 'slow_down':
        return { status: 'pending', interval: t.interval ?? 10, account: null };
      case 'expired_token':
        return { status: 'expired', interval: 0, account: null };
      case 'access_denied':
        return { status: 'denied', interval: 0, account: null };
      default:
        throw new AppError(`GitHub : ${t.error_description ?? t.error}`);
    }
  },
};
