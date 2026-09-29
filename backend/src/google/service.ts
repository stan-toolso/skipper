import { config } from '../config.js';
import { AppError, NotFoundError } from '../errors.js';
import type { Project } from '../projects/types.js';
import { decryptSecret, encryptSecret } from '../settings/crypto.js';
import { googleAccountRepository } from './repository.js';
import { GOOGLE_ACCESSES, type GoogleAccess, type GoogleAccessRequest, type GoogleAccount, type GoogleAccountCheckResult } from './types.js';

/**
 * Compte Google relié à un projet : flux OAuth « authorization code » avec accès hors ligne
 * (jeton de rafraîchissement), stockage chiffré, jetons d'accès renouvelés en mémoire, appels aux
 * API Google au nom du compte. Le service est le seul à voir les jetons en clair : les agents
 * passent par les outils MCP (`google/mcp.ts`).
 *
 * Le même client OAuth que la connexion des utilisateurs est employé (GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET) et le retour passe par le même callback `/auth/google/callback` : rien de
 * plus à déclarer dans la console Google Cloud, sinon activer les API Gmail et Drive.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const DRIVE_READ = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_FULL = 'https://www.googleapis.com/auth/drive';

export const accessLabels: Record<GoogleAccess, string> = { none: 'aucun accès', read: 'lecture', write: 'lecture et écriture' };

/** Portées OAuth à demander pour les accès voulus. */
function scopesFor(req: GoogleAccessRequest): string[] {
  const scopes = ['openid', 'email', 'profile'];
  if (req.gmail !== 'none') scopes.push(GMAIL_READ);
  if (req.gmail === 'write') scopes.push(GMAIL_SEND);
  if (req.drive === 'read') scopes.push(DRIVE_READ);
  if (req.drive === 'write') scopes.push(DRIVE_FULL);
  return scopes;
}

/** Accès réellement obtenus, d'après les portées accordées (l'utilisateur peut en décocher sur l'écran Google). */
function grantedAccess(scopes: string[]): GoogleAccessRequest {
  const has = (s: string) => scopes.includes(s);
  const gmail: GoogleAccess = has(GMAIL_SEND) || has('https://mail.google.com/') ? 'write' : has(GMAIL_READ) || has('https://www.googleapis.com/auth/gmail.modify') ? 'read' : 'none';
  const drive: GoogleAccess = has(DRIVE_FULL) ? 'write' : has(DRIVE_READ) || has('https://www.googleapis.com/auth/drive.file') ? 'read' : 'none';
  return { gmail, drive };
}

export function parseAccess(value: string | null | undefined, label: string): GoogleAccess {
  const v = (value ?? 'none') as GoogleAccess;
  if (!GOOGLE_ACCESSES.includes(v)) throw new AppError(`Niveau d'accès ${label} invalide : ${value}`);
  return v;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Jetons d'accès en cours de validité, par projet (jamais persistés). */
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...params }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    const err = new AppError(`Google : ${body.error_description ?? body.error ?? `réponse ${res.status}`}`, body.error === 'invalid_grant' ? 'GOOGLE_RECONNECT' : 'GOOGLE_ERROR');
    throw err;
  }
  return body;
}

/** Message d'erreur lisible d'une réponse d'API Google. */
async function apiError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } | string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return `${parsed.error.message}${parsed.error.status ? ` (${parsed.error.status})` : ''}`;
  } catch {
    /* pas du JSON */
  }
  return `${res.status} ${res.statusText}${text ? ` : ${text.slice(0, 200)}` : ''}`;
}

export const googleAccountService = {
  get configured(): boolean {
    return Boolean(config.googleClientId && config.googleClientSecret);
  },

  get redirectUri(): string {
    return `${config.apiUrl}/auth/google/callback`;
  },

  find: (projectId: string) => googleAccountRepository.findByProject(projectId),

  async get(projectId: string): Promise<GoogleAccount> {
    const account = await googleAccountRepository.findByProject(projectId);
    if (!account) throw new NotFoundError('Aucun compte Google relié à ce projet');
    return account;
  },

  /** URL de l'écran de consentement Google, avec accès hors ligne (jeton de rafraîchissement). */
  authorizationUrl(state: string, req: GoogleAccessRequest): string {
    if (req.gmail === 'none' && req.drive === 'none') throw new AppError('Choisissez au moins un accès (messagerie ou Drive)');
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: scopesFor(req).join(' '),
      state,
      access_type: 'offline',
      // `consent` garantit un jeton de rafraîchissement, même si le compte a déjà autorisé l'application.
      prompt: 'consent select_account',
      include_granted_scopes: 'false',
    });
    return `${AUTH_URL}?${params}`;
  },

  /** Retour du consentement : échange le code, lit le profil, enregistre le compte (chiffré). */
  async connect(projectId: string, code: string, connectedById: string | null): Promise<GoogleAccount> {
    const tokens = await tokenRequest({ code, redirect_uri: this.redirectUri, grant_type: 'authorization_code' });
    if (!tokens.refresh_token) throw new AppError("Google n'a pas fourni de jeton de rafraîchissement : recommencez la connexion", 'GOOGLE_ERROR');
    const scopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
    const access = grantedAccess(scopes);
    if (access.gmail === 'none' && access.drive === 'none') {
      await this.revoke(tokens.refresh_token);
      throw new AppError("Aucun accès accordé : sur l'écran Google, laissez cochés la messagerie et/ou le Drive", 'GOOGLE_ERROR');
    }
    const infoRes = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    if (!infoRes.ok) throw new AppError(`Lecture du profil Google impossible (${infoRes.status})`, 'GOOGLE_ERROR');
    const info = (await infoRes.json()) as { sub?: string; email?: string; name?: string; picture?: string };
    if (!info.sub || !info.email) throw new AppError('Profil Google incomplet', 'GOOGLE_ERROR');

    // Un compte précédent est remplacé : son jeton est révoqué pour ne pas laisser d'accès dormant.
    const previous = await googleAccountRepository.findByProject(projectId);
    if (previous) await this.revoke(previous.refreshToken, true);

    const account = await googleAccountRepository.upsert(projectId, {
      email: info.email.toLowerCase(),
      name: info.name ?? null,
      avatarUrl: info.picture ?? null,
      googleSub: info.sub,
      gmailAccess: access.gmail,
      driveAccess: access.drive,
      scopes,
      refreshToken: encryptSecret(tokens.refresh_token),
      connectedById,
    });
    accessTokens.set(projectId, { token: tokens.access_token!, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 });
    console.log(`[google] compte ${account.email} relié au projet ${projectId} (gmail: ${access.gmail}, drive: ${access.drive})`);
    return account;
  },

  /** Révocation côté Google (au mieux : un jeton déjà révoqué renvoie une erreur sans conséquence). */
  async revoke(token: string, encrypted = false): Promise<void> {
    try {
      const plain = encrypted ? decryptSecret(token) : token;
      await fetch(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: plain }) });
    } catch (err) {
      console.warn('[google] révocation impossible :', (err as Error).message);
    }
  },

  async disconnect(projectId: string): Promise<boolean> {
    const account = await googleAccountRepository.findByProject(projectId);
    if (!account) return false;
    await this.revoke(account.refreshToken, true);
    accessTokens.delete(projectId);
    return googleAccountRepository.delete(projectId);
  },

  /** Jeton d'accès valide pour le compte du projet, renouvelé au besoin avec le jeton de rafraîchissement. */
  async accessToken(projectId: string, force = false): Promise<string> {
    const cached = accessTokens.get(projectId);
    if (!force && cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const account = await this.get(projectId);
    let refreshToken: string;
    try {
      refreshToken = decryptSecret(account.refreshToken);
    } catch {
      throw new AppError('Jeton Google illisible (clé de chiffrement changée ?) : reconnectez le compte', 'GOOGLE_RECONNECT');
    }
    try {
      const tokens = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
      accessTokens.set(projectId, { token: tokens.access_token!, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 });
      return tokens.access_token!;
    } catch (err) {
      if (err instanceof AppError && err.code === 'GOOGLE_RECONNECT') {
        await googleAccountRepository.recordCheck(projectId, false, 'Accès révoqué ou expiré : reconnectez le compte');
        throw new AppError(`Le compte Google ${account.email} n'a plus accès (jeton révoqué ou expiré) : reconnectez-le depuis la page du projet`, 'GOOGLE_RECONNECT');
      }
      throw err;
    }
  },

  /** Appel d'API Google au nom du compte du projet ; un 401 provoque un renouvellement du jeton et une nouvelle tentative. */
  async fetch(projectId: string, url: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async (force: boolean) => {
      const token = await this.accessToken(projectId, force);
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      return fetch(url, { ...init, headers });
    };
    const res = await attempt(false);
    return res.status === 401 ? attempt(true) : res;
  },

  /** Appel d'API renvoyant du JSON ; les erreurs Google deviennent des AppError lisibles. */
  async json<T>(projectId: string, url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(projectId, url, init);
    if (!res.ok) throw new AppError(`Google : ${await apiError(res)}`, 'GOOGLE_ERROR');
    return (await res.json()) as T;
  },

  /** Réponse brute (téléchargement) ; les erreurs Google deviennent des AppError lisibles. */
  async raw(projectId: string, url: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetch(projectId, url, init);
    if (!res.ok) throw new AppError(`Google : ${await apiError(res)}`, 'GOOGLE_ERROR');
    return res;
  },

  /** Vérifie depuis l'interface que le compte répond encore, et avec quels droits. */
  async check(projectId: string): Promise<{ account: GoogleAccount; result: GoogleAccountCheckResult }> {
    const account = await this.get(projectId);
    let result: GoogleAccountCheckResult;
    try {
      const details: string[] = [];
      const info = await this.json<{ email?: string }>(projectId, USERINFO_URL);
      details.push(info.email ?? account.email);
      if (account.gmailAccess !== 'none') {
        const p = await this.json<{ messagesTotal?: number; threadsTotal?: number }>(projectId, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
        details.push(`Gmail : ${p.messagesTotal ?? '?'} messages`);
      }
      if (account.driveAccess !== 'none') {
        const a = await this.json<{ storageQuota?: { usage?: string; limit?: string } }>(projectId, 'https://www.googleapis.com/drive/v3/about?fields=storageQuota');
        const gb = (v?: string) => (v ? `${(Number(v) / 1e9).toFixed(1)} Go` : '?');
        details.push(`Drive : ${gb(a.storageQuota?.usage)} utilisés${a.storageQuota?.limit ? ` sur ${gb(a.storageQuota.limit)}` : ''}`);
      }
      result = { ok: true, error: null, detail: details.join(' · ') };
    } catch (err) {
      result = { ok: false, error: (err as Error).message, detail: null };
    }
    await googleAccountRepository.recordCheck(projectId, result.ok, result.error);
    return { account: await this.get(projectId), result };
  },

  /** Description du compte pour le prompt système d'une session ; vide si aucun compte. */
  async promptSummary(project: Pick<Project, 'id'>): Promise<string> {
    const account = await googleAccountRepository.findByProject(project.id);
    if (!account) return '';
    const lines = [`Le projet est relié au compte Google \`${account.email}\` par les outils du serveur MCP \`google\` (le serveur détient les jetons : tu n'as pas à les connaître). Les lectures sont libres ; les écritures (envoi de mail, dépôt sur le Drive) sont soumises à l'approbation d'un humain.`];
    if (account.gmailAccess !== 'none') {
      lines.push(`- Messagerie Gmail (${accessLabels[account.gmailAccess]}) : \`gmail_search\` (requête au format de la recherche Gmail, ex. \`from:x newer_than:7d\`), \`gmail_read\`${account.gmailAccess === 'write' ? ', `gmail_send` (envoi ou réponse, au nom de ce compte)' : ''}.`);
    }
    if (account.driveAccess !== 'none') {
      lines.push(`- Drive (${accessLabels[account.driveAccess]}) : \`drive_search\`, \`drive_read\` (texte des Docs, Sheets en CSV, fichiers texte), \`drive_download\` (dans le dossier de travail)${account.driveAccess === 'write' ? ', `drive_upload` (fichier du dossier de travail, conversion en Doc ou Sheet possible), `drive_write` (créer ou remplacer un Google Doc à partir d\'un texte)' : ''}.`);
    }
    return lines.join('\n');
  },
};

/** Outils du serveur `google` accessibles sans approbation (lectures) pour un compte donné. */
export function googleReadTools(account: GoogleAccount): string[] {
  const tools: string[] = ['mcp__google__account'];
  if (account.gmailAccess !== 'none') tools.push('mcp__google__gmail_search', 'mcp__google__gmail_read');
  if (account.driveAccess !== 'none') tools.push('mcp__google__drive_search', 'mcp__google__drive_read', 'mcp__google__drive_download');
  return tools;
}
