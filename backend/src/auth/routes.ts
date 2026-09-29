import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { AppError } from '../errors.js';
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
 * Routes HTTP d'authentification, à côté de GraphQL :
 * - GET  /auth/google?next=/chemin : redirige vers Google ;
 * - GET  /auth/google/callback      : retour de Google, ouvre la session et renvoie vers l'application ;
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

  if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
    let expected: { state: string; next: string } | null = null;
    try {
      const raw = readCookie(req.headers.cookie, STATE_COOKIE);
      expected = raw ? JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) : null;
    } catch {
      expected = null;
    }
    const code = url.searchParams.get('code');
    if (url.searchParams.get('error') || !code) {
      redirect(res, loginError(url.searchParams.get('error') ?? 'cancelled'), [stateCookie(null)]);
      return true;
    }
    if (!expected || url.searchParams.get('state') !== expected.state) {
      redirect(res, loginError('invalid_state'), [stateCookie(null)]);
      return true;
    }
    try {
      const profile = await googleAuth.fetchProfile(code);
      const user = await userService.loginWithGoogle(profile);
      const token = await authSession.create(user);
      console.log(`[auth] connexion de ${user.email}`);
      redirect(res, toApp(expected.next), [stateCookie(null), authSession.cookie(token)]);
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
