import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { googleAccountService, parseAccess } from '../google/service.js';
import { userService } from '../users/service.js';
import { vaultService } from '../vault/service.js';
import { googleAuth } from './google.js';
import { authSession, readCookie, SESSION_COOKIE } from './session.js';

const STATE_COOKIE = 'skipper_oauth';

/** Chemin de retour dans l'application : uniquement un chemin relatif (jamais une URL externe). */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.writeHead(302, { Location: location });
  res.end();
}

function stateCookie(value: string | null): string {
  const attrs = ['Path=/auth', 'HttpOnly', 'SameSite=Lax', value ? 'Max-Age=600' : 'Max-Age=0'];
  if (config.apiUrl.startsWith('https://')) attrs.push('Secure');
  return `${STATE_COOKIE}=${value ?? ''}; ${attrs.join('; ')}`;
}

const toApp = (path: string) => `${config.appUrl}${path}`;
const loginError = (code: string) => toApp(`/?authError=${encodeURIComponent(code)}`);

/**
 * Contenu du cookie d'état : connexion d'un utilisateur (`next`) ou rattachement d'un compte Google au coffre
 * (`vault` : coffre d'un projet ou personnel, avec `replaceId` quand il remplace un compte déjà relié).
 */
interface OAuthState {
  state: string;
  next?: string;
  vault?: { projectId: string | null; userId: string; replaceId?: string };
}
const vaultPage = (projectId: string | null, params: Record<string, string>) => toApp(`${projectId ? `/projects/${projectId}/vault` : '/vault'}?${new URLSearchParams(params)}`);

/**
 * Routes HTTP d'authentification, à côté de GraphQL :
 * - GET  /auth/google?next=/chemin : redirige vers Google ;
 * - GET  /auth/google/callback      : retour de Google, ouvre la session et renvoie vers l'application ;
 * - GET  /auth/google/connect?(projectId=…|personal=1)&gmail=read|write|none&drive=read|write|none[&itemId=…] :
 *   relie un compte Google au coffre du projet (administrateur) ou au coffre personnel, ou remplace l'élément
 *   `itemId` ; le retour passe par le même callback et ramène sur la page du coffre ;
 * - POST /auth/logout               : ferme la session.
 * Renvoie false si l'URL n'est pas une route d'authentification.
 */
export async function handleAuthRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', config.apiUrl);
  if (!url.pathname.startsWith('/auth/')) return false;

  if (url.pathname === '/auth/google' && req.method === 'GET') {
    if (!googleAuth.configured) {
      redirect(res, loginError('not_configured'));
      return true;
    }
    const state = randomBytes(16).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ state, next: safeNext(url.searchParams.get('next')) })).toString('base64url');
    redirect(res, googleAuth.authorizationUrl(state), [stateCookie(payload)]);
    return true;
  }

  if (url.pathname === '/auth/google/connect' && req.method === 'GET') {
    const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (!user) {
      redirect(res, loginError('unauthenticated'));
      return true;
    }
    const projectId = url.searchParams.get('projectId') || null;
    try {
      if (!googleAccountService.configured) throw new AppError('Connexion Google non configurée (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)', 'NOT_CONFIGURED');
      if (projectId && (await userService.roleFor(user.id, projectId)) !== 'admin') throw new AppError('Réservé aux administrateurs du projet', 'FORBIDDEN');
      const access = { gmail: parseAccess(url.searchParams.get('gmail'), 'messagerie'), drive: parseAccess(url.searchParams.get('drive'), 'Drive') };
      const replaceId = url.searchParams.get('itemId') || undefined;
      if (replaceId) {
        const item = await vaultService.getFor(user.id, replaceId, 'manage');
        if (item.kind !== 'google' || item.ownerProjectId !== projectId || item.ownerUserId !== (projectId ? null : user.id)) throw new AppError('Compte Google introuvable dans ce coffre', 'NOT_FOUND');
      }
      const state = randomBytes(16).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ state, vault: { projectId, userId: user.id, replaceId } } satisfies OAuthState)).toString('base64url');
      redirect(res, googleAccountService.authorizationUrl(state, access), [stateCookie(payload)]);
    } catch (err) {
      redirect(res, vaultPage(projectId, { googleError: (err as Error).message }));
    }
    return true;
  }

  if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
    let expected: OAuthState | null = null;
    try {
      const raw = readCookie(req.headers.cookie, STATE_COOKIE);
      expected = raw ? JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) : null;
    } catch {
      expected = null;
    }
    const code = url.searchParams.get('code');
    const vault = expected?.vault;
    if (url.searchParams.get('error') || !code) {
      const error = url.searchParams.get('error') ?? 'cancelled';
      redirect(res, vault ? vaultPage(vault.projectId, { googleError: error === 'access_denied' ? 'Autorisation refusée sur Google' : error }) : loginError(error), [stateCookie(null)]);
      return true;
    }
    if (!expected || url.searchParams.get('state') !== expected.state) {
      redirect(res, vault ? vaultPage(vault.projectId, { googleError: 'État OAuth invalide, recommencez' }) : loginError('invalid_state'), [stateCookie(null)]);
      return true;
    }
    if (vault) {
      // Rattachement d'un compte Google au coffre : l'utilisateur de la session doit être celui qui a lancé le flux, et toujours habilité.
      try {
        const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
        if (!user || user.id !== vault.userId) throw new AppError('Session expirée, reconnectez-vous puis recommencez', 'UNAUTHENTICATED');
        if (vault.projectId && (await userService.roleFor(user.id, vault.projectId)) !== 'admin') throw new AppError('Réservé aux administrateurs du projet', 'FORBIDDEN');
        const item = await googleAccountService.connect({ userId: vault.projectId ? null : user.id, projectId: vault.projectId }, code, { userId: user.id, projectId: vault.projectId }, vault.replaceId);
        redirect(res, vaultPage(vault.projectId, { google: 'connected', email: (item.settings as { email: string }).email, item: item.id }), [stateCookie(null)]);
      } catch (err) {
        console.error('[google] rattachement refusé :', (err as Error).message);
        redirect(res, vaultPage(vault.projectId, { googleError: (err as Error).message }), [stateCookie(null)]);
      }
      return true;
    }
    try {
      const profile = await googleAuth.fetchProfile(code);
      const user = await userService.loginWithGoogle(profile);
      const token = await authSession.create(user);
      console.log(`[auth] connexion de ${user.email}`);
      redirect(res, toApp(expected.next ?? '/'), [stateCookie(null), authSession.cookie(token)]);
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'google_error';
      console.error('[auth] connexion refusée :', (err as Error).message);
      redirect(res, loginError(code.toLowerCase()), [stateCookie(null)]);
    }
    return true;
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    await authSession.destroy(readCookie(req.headers.cookie, SESSION_COOKIE));
    res.setHeader('Set-Cookie', authSession.cookie(null));
    res.writeHead(204);
    res.end();
    return true;
  }

  res.writeHead(404);
  res.end();
  return true;
}
