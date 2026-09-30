import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { googleAccountService } from '../google/service.js';
import { parseAccess } from '../google/service.js';
import { userService } from '../users/service.js';
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
 * Contenu du cookie d'état : connexion d'un utilisateur (`next`) ou rattachement d'un compte Google à un projet
 * (`project`, avec `replaceId` quand il remplace un compte déjà relié).
 */
interface OAuthState {
  state: string;
  next?: string;
  project?: { id: string; userId: string; replaceId?: string };
}
const projectPage = (id: string, params: Record<string, string>) => toApp(`/projects/${id}?${new URLSearchParams(params)}`);

/**
 * Routes HTTP d'authentification, à côté de GraphQL :
 * - GET  /auth/google?next=/chemin : redirige vers Google ;
 * - GET  /auth/google/callback      : retour de Google, ouvre la session et renvoie vers l'application ;
 * - GET  /auth/google/connect?projectId=…&gmail=read|write|none&drive=read|write|none[&accountId=…] : relie un
 *   compte Google (de plus) au projet, ou remplace le compte `accountId` (administrateur du projet) ; le retour
 *   passe par le même callback ;
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
    const projectId = url.searchParams.get('projectId') ?? '';
    try {
      if ((await userService.roleFor(user.id, projectId)) !== 'admin') throw new AppError('Réservé aux administrateurs du projet', 'FORBIDDEN');
      const access = { gmail: parseAccess(url.searchParams.get('gmail'), 'messagerie'), drive: parseAccess(url.searchParams.get('drive'), 'Drive') };
      const replaceId = url.searchParams.get('accountId') || undefined;
      if (replaceId && (await googleAccountService.get(replaceId)).projectId !== projectId) throw new AppError('Compte Google introuvable dans ce projet', 'NOT_FOUND');
      const state = randomBytes(16).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ state, project: { id: projectId, userId: user.id, replaceId } } satisfies OAuthState)).toString('base64url');
      redirect(res, googleAccountService.authorizationUrl(state, access), [stateCookie(payload)]);
    } catch (err) {
      redirect(res, projectPage(projectId, { googleError: (err as Error).message }));
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
    const project = expected?.project;
    if (url.searchParams.get('error') || !code) {
      const error = url.searchParams.get('error') ?? 'cancelled';
      redirect(res, project ? projectPage(project.id, { googleError: error === 'access_denied' ? 'Autorisation refusée sur Google' : error }) : loginError(error), [stateCookie(null)]);
      return true;
    }
    if (!expected || url.searchParams.get('state') !== expected.state) {
      redirect(res, project ? projectPage(project.id, { googleError: 'État OAuth invalide, recommencez' }) : loginError('invalid_state'), [stateCookie(null)]);
      return true;
    }
    if (project) {
      // Rattachement d'un compte Google à un projet : l'utilisateur de la session doit être celui qui a lancé le flux, et toujours administrateur.
      try {
        const user = await authSession.resolve(readCookie(req.headers.cookie, SESSION_COOKIE));
        if (!user || user.id !== project.userId) throw new AppError('Session expirée, reconnectez-vous puis recommencez', 'UNAUTHENTICATED');
        if ((await userService.roleFor(user.id, project.id)) !== 'admin') throw new AppError('Réservé aux administrateurs du projet', 'FORBIDDEN');
        const account = await googleAccountService.connect(project.id, code, user.id, project.replaceId);
        redirect(res, projectPage(project.id, { google: 'connected', email: account.email }), [stateCookie(null)]);
      } catch (err) {
        console.error('[google] rattachement refusé :', (err as Error).message);
        redirect(res, projectPage(project.id, { googleError: (err as Error).message }), [stateCookie(null)]);
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
