import { config } from '../config.js';
import { AppError, NotFoundError } from '../errors.js';
import type { Project } from '../projects/types.js';
import { sealSecrets } from '../vault/crypto.js';
import { vaultRepository } from '../vault/repository.js';
import { vaultService } from '../vault/service.js';
import { GOOGLE_ACCESSES, type GoogleSettings, type VaultActor, type VaultItem } from '../vault/types.js';
import type { GoogleAccess, GoogleAccessRequest, GoogleAccount } from './types.js';

/**
 * Comptes Google du coffre (éléments `google`, personnels ou d'un projet) : flux OAuth « authorization
 * code » avec accès hors ligne (jeton de rafraîchissement, chiffré dans le coffre), jetons d'accès
 * renouvelés en mémoire, appels aux API Google au nom du compte. Le service est le seul à voir les
 * jetons en clair : les agents passent par les outils MCP (`google/mcp.ts`).
 *
 * Le même client OAuth que la connexion des utilisateurs est employé (GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET) et le retour passe par le même callback `/auth/google/callback`.
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

/** Jetons d'accès en cours de validité, par élément (jamais persistés). */
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...params }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    throw new AppError(`Google : ${body.error_description ?? body.error ?? `réponse ${res.status}`}`, body.error === 'invalid_grant' ? 'GOOGLE_RECONNECT' : 'GOOGLE_ERROR');
  }
  return body;
}

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

/** Vue « compte » d'un élément google du coffre. */
export function accountOf(item: VaultItem): GoogleAccount {
  const s = item.settings as GoogleSettings;
  return { id: item.id, name: item.name, email: s.email, displayName: s.displayName ?? null, avatarUrl: s.avatarUrl ?? null, googleSub: s.googleSub, gmailAccess: s.gmailAccess ?? 'none', driveAccess: s.driveAccess ?? 'none', scopes: s.scopes ?? [], requireApproval: item.requireApproval };
}

/** Nom d'élément dérivé d'une adresse : google-<partie locale>, unique parmi les noms pris. */
function googleItemName(email: string, taken: Set<string>): string {
  const base = `google-${email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+$/, '').slice(0, 33) || 'compte'}`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `google-${Math.random().toString(16).slice(2, 10)}`;
}

export const googleAccountService = {
  get configured(): boolean {
    return Boolean(config.googleClientId && config.googleClientSecret);
  },

  get redirectUri(): string {
    return `${config.apiUrl}/auth/google/callback`;
  },

  /** Élément google lu sans contrôle de droits (les outils l'ont résolu dans la portée de la session). */
  async get(id: string): Promise<GoogleAccount> {
    const item = await vaultRepository.findById(id);
    if (!item || item.kind !== 'google') throw new NotFoundError('Compte Google introuvable');
    return accountOf(item);
  },

  /** Comptes Google de la portée d'une session, dédoublonnés par compte Google (le premier dans l'ordre de la portée gagne). */
  async accountsFor(projectId: string, ownerId: string | null): Promise<GoogleAccount[]> {
    const seen = new Set<string>();
    const out: GoogleAccount[] = [];
    for (const item of await vaultService.agentItems(projectId, ownerId)) {
      if (item.kind !== 'google') continue;
      const a = accountOf(item);
      if (seen.has(a.googleSub)) continue;
      seen.add(a.googleSub);
      out.push(a);
    }
    return out;
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
      prompt: 'consent select_account',
      include_granted_scopes: 'false',
    });
    return `${AUTH_URL}?${params}`;
  },

  /**
   * Retour du consentement : échange le code, lit le profil, enregistre le compte dans le coffre du projet
   * ou le coffre personnel. Un même compte Google déjà présent dans ce coffre est mis à jour ; `replaceId`
   * désigne l'élément à remplacer (« changer de compte ») : un autre compte Google le remplace.
   */
  async connect(owner: { userId: string | null; projectId: string | null }, code: string, actor: VaultActor & { userId: string }, replaceId?: string | null): Promise<VaultItem> {
    const replaced = replaceId ? await vaultRepository.findById(replaceId) : null;
    if (replaceId && (!replaced || replaced.kind !== 'google' || replaced.ownerUserId !== owner.userId || replaced.ownerProjectId !== owner.projectId)) throw new AppError('Compte Google introuvable dans ce coffre', 'NOT_FOUND');
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

    const settings: GoogleSettings = { email: info.email.toLowerCase(), displayName: info.name ?? null, avatarUrl: info.picture ?? null, googleSub: info.sub, gmailAccess: access.gmail, driveAccess: access.drive, scopes };
    const existing = await vaultRepository.findGoogleBySub(owner.userId, owner.projectId, info.sub);
    let item: VaultItem;
    if (existing) {
      item = await vaultRepository.update(existing.id, { settings, ...sealSecrets(existing.id, 'google', { refreshToken: tokens.refresh_token }) });
    } else {
      const taken = new Set((owner.projectId ? await vaultRepository.listOwnedByProject(owner.projectId) : await vaultRepository.listOwnedByUser(owner.userId!)).map((i) => i.name));
      const name = googleItemName(settings.email, taken);
      if (owner.projectId) await vaultService.assertNameFree(owner.projectId, null, name, null);
      const { randomUUID } = await import('node:crypto');
      const id = randomUUID();
      item = await vaultRepository.create({
        id,
        ownerUserId: owner.userId,
        ownerProjectId: owner.projectId,
        name,
        kind: 'google',
        description: '',
        settings,
        ...sealSecrets(id, 'google', { refreshToken: tokens.refresh_token }),
        publicKey: null,
        readOnly: false,
        requireApproval: true,
        commandAllowlist: [],
        expiresAt: null,
        createdById: actor.userId,
      });
    }
    await vaultRepository.recordTest(item.id, true, null);
    accessTokens.set(item.id, { token: tokens.access_token!, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 });
    // Un autre compte Google remplacé : détaché, son jeton révoqué pour ne pas laisser d'accès dormant.
    if (replaced && replaced.id !== item.id) {
      await this.beforeDelete(replaced);
      await vaultService.audit(replaced, 'deleted', actor, `remplacé par ${settings.email}`);
      await vaultRepository.delete(replaced.id);
    }
    await vaultService.audit(item, 'connected', actor, `${settings.email} · Gmail ${access.gmail}, Drive ${access.drive}`);
    console.log(`[google] compte ${settings.email} relié (${owner.projectId ? `projet ${owner.projectId}` : 'coffre personnel'}, gmail: ${access.gmail}, drive: ${access.drive})`);
    return item;
  },

  /** Révocation côté Google (au mieux : un jeton déjà révoqué renvoie une erreur sans conséquence). */
  async revoke(token: string): Promise<void> {
    try {
      await fetch(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
    } catch (err) {
      console.warn('[google] révocation impossible :', (err as Error).message);
    }
  },

  /** Avant la suppression d'un élément google : révoque le jeton sauf si un autre élément porte le même compte. */
  async beforeDelete(item: VaultItem): Promise<void> {
    const s = item.settings as GoogleSettings;
    if ((await vaultRepository.countGoogleBySub(s.googleSub)) <= 1) {
      try {
        const refreshToken = vaultService.secretsOf(item).refreshToken;
        if (refreshToken) await this.revoke(refreshToken);
      } catch (err) {
        console.warn('[google] jeton illisible, révocation ignorée :', (err as Error).message);
      }
    }
    accessTokens.delete(item.id);
  },

  /** Jeton d'accès valide pour le compte, renouvelé au besoin avec le jeton de rafraîchissement. */
  async accessToken(itemId: string, force = false): Promise<string> {
    const cached = accessTokens.get(itemId);
    if (!force && cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const item = await vaultService.getInternal(itemId);
    if (item.kind !== 'google') throw new NotFoundError('Compte Google introuvable');
    let refreshToken: string | undefined;
    try {
      refreshToken = vaultService.secretsOf(item).refreshToken;
    } catch {
      throw new AppError('Jeton Google illisible (clé de chiffrement changée ?) : reconnectez le compte', 'GOOGLE_RECONNECT');
    }
    if (!refreshToken) throw new AppError('Compte Google sans jeton : reconnectez-le', 'GOOGLE_RECONNECT');
    try {
      const tokens = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
      accessTokens.set(itemId, { token: tokens.access_token!, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 });
      return tokens.access_token!;
    } catch (err) {
      if (err instanceof AppError && err.code === 'GOOGLE_RECONNECT') {
        await vaultRepository.recordTest(itemId, false, 'Accès révoqué ou expiré : reconnectez le compte');
        throw new AppError(`Le compte Google ${(item.settings as GoogleSettings).email} n'a plus accès (jeton révoqué ou expiré) : reconnectez-le depuis le coffre`, 'GOOGLE_RECONNECT');
      }
      throw err;
    }
  },

  /** Appel d'API Google au nom du compte ; un 401 provoque un renouvellement du jeton et une nouvelle tentative. */
  async fetch(itemId: string, url: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async (force: boolean) => {
      const token = await this.accessToken(itemId, force);
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      return fetch(url, { ...init, headers });
    };
    const res = await attempt(false);
    return res.status === 401 ? attempt(true) : res;
  },

  async json<T>(itemId: string, url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(itemId, url, init);
    if (!res.ok) throw new AppError(`Google : ${await apiError(res)}`, 'GOOGLE_ERROR');
    return (await res.json()) as T;
  },

  async raw(itemId: string, url: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetch(itemId, url, init);
    if (!res.ok) throw new AppError(`Google : ${await apiError(res)}`, 'GOOGLE_ERROR');
    return res;
  },

  /** Test d'un élément google : profil, Gmail et Drive selon les accès. */
  async probe(item: VaultItem): Promise<string> {
    const a = accountOf(item);
    const details: string[] = [];
    const info = await this.json<{ email?: string }>(item.id, USERINFO_URL);
    details.push(info.email ?? a.email);
    if (a.gmailAccess !== 'none') {
      const p = await this.json<{ messagesTotal?: number }>(item.id, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
      details.push(`Gmail : ${p.messagesTotal ?? '?'} messages`);
    }
    if (a.driveAccess !== 'none') {
      const d = await this.json<{ storageQuota?: { usage?: string; limit?: string } }>(item.id, 'https://www.googleapis.com/drive/v3/about?fields=storageQuota');
      const gb = (v?: string) => (v ? `${(Number(v) / 1e9).toFixed(1)} Go` : '?');
      details.push(`Drive : ${gb(d.storageQuota?.usage)} utilisés${d.storageQuota?.limit ? ` sur ${gb(d.storageQuota.limit)}` : ''}`);
    }
    return details.join(' · ');
  },

  /** Description des comptes pour le prompt système d'une session ; vide si aucun compte. */
  promptSummary(accounts: GoogleAccount[], _project?: Pick<Project, 'id'>): string {
    if (!accounts.length) return '';
    const several = accounts.length > 1;
    const lines = [
      several
        ? `La session dispose de ${accounts.length} comptes Google par les outils du serveur MCP \`google\` (le serveur détient les jetons : tu n'as pas à les connaître). Chaque outil prend un paramètre \`account\` : l'adresse du compte à utiliser. Les lectures sont libres ; les écritures (envoi de mail, dépôt sur le Drive) sont soumises à l'approbation d'un humain.`
        : `La session dispose du compte Google \`${accounts[0].email}\` par les outils du serveur MCP \`google\` (le serveur détient les jetons : tu n'as pas à les connaître). Les lectures sont libres ; les écritures (envoi de mail, dépôt sur le Drive) sont soumises à l'approbation d'un humain.`,
    ];
    for (const account of accounts) {
      if (several) lines.push(`Compte \`${account.email}\`${account.displayName ? ` (${account.displayName})` : ''} :`);
      const indent = several ? '  ' : '';
      if (account.gmailAccess !== 'none') {
        lines.push(`${indent}- Messagerie Gmail (${accessLabels[account.gmailAccess]}) : \`gmail_search\` (requête au format de la recherche Gmail, ex. \`from:x newer_than:7d\`), \`gmail_read\`, \`gmail_attachment\` (télécharge une pièce jointe d'un mail dans le dossier de travail, pour la lire ou la déposer ailleurs)${account.gmailAccess === 'write' ? ', `gmail_send` (envoi ou réponse, au nom de ce compte)' : ''}.`);
      }
      if (account.driveAccess !== 'none') {
        lines.push(`${indent}- Drive (${accessLabels[account.driveAccess]}) : \`drive_search\`, \`drive_read\` (texte des Docs, Sheets en CSV, fichiers texte), \`drive_download\` (dans le dossier de travail)${account.driveAccess === 'write' ? ', `drive_upload` (fichier du dossier de travail, conversion en Doc ou Sheet possible), `drive_write` (créer ou remplacer un Google Doc à partir d\'un texte)' : ''}.`);
      }
    }
    return lines.join('\n');
  },
};

vaultService.onBeforeDelete('google', (item) => googleAccountService.beforeDelete(item));
vaultService.probers.set('google', (item) => googleAccountService.probe(item));

/** Outils du serveur `google` accessibles sans approbation (lectures), d'après les accès de l'ensemble des comptes. */
export function googleReadTools(accounts: GoogleAccount[]): string[] {
  const tools: string[] = ['mcp__google__account'];
  if (accounts.some((a) => a.gmailAccess !== 'none')) tools.push('mcp__google__gmail_search', 'mcp__google__gmail_read', 'mcp__google__gmail_attachment');
  if (accounts.some((a) => a.driveAccess !== 'none')) tools.push('mcp__google__drive_search', 'mcp__google__drive_read', 'mcp__google__drive_download');
  return tools;
}
